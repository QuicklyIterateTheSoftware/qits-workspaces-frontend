import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { QitsButton } from '@qits/ui-components';
import { CommandsApi, type CommandDto } from '../../api/commands-api';
import { PromptDraftApi } from '../../api/prompt-draft-api';
import { SpeechApi } from '../../api/speech-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { relativeSince } from '../../ui/format';
import { AgentSignIn, isSignInTerminal } from '../agents/agent-sign-in';
import { SignInNotice } from '../agents/sign-in-notice';
import { FileNavigation } from '../files/file-navigation';
import { describeError } from '../../ui/loadable';
import { LevelMeter } from './level-meter';
import {
  PickedContext,
  elementText,
  parseComposition,
  referenceLabel,
  referenceText,
  serializePrompt,
  type CodeReference,
  type DraftComposition,
} from './picked-context';
import { SpeechRecorder } from './recorder';
import { SPEECH_RUNTIME } from './speech-runtime';

/** How long typing has to stop before the draft is saved. */
export const DRAFT_DEBOUNCE_MS = 750;

/** Where the composition is in its life. */
type SaveState = 'clean' | 'pending' | 'saving' | 'dirty';

/**
 * Compose the next thing to ask the agent.
 *
 * ## What it loads
 *
 * **One request**: `GET /workspaces/api/workspaces/{id}/prompt-draft`. A 404 means nothing was ever
 * composed here, which is a different screen from an empty one — it is why the restored-draft hint
 * can be honest.
 *
 * ## Four inputs, two boxes, one draft
 *
 * Speech, refinement, picked context and typed text all end up in one prompt, but they do not all
 * write to the same place, and the split is the original's rather than an embellishment.
 *
 * **Dictation accumulates in its own transcript box.** Raw speech is not a prompt: it has false
 * starts, self-corrections and misheard words in it, and a box you can read and fix before promoting
 * is the difference between dictating and dictating-and-hoping. Nothing in the transcript is a draft
 * — it is scratch, and it is not saved.
 *
 * **Two buttons promote it into the prompt box, and that is all either of them does.** "Refine into
 * prompt" sends the transcript to the model that rewrites speech into a task prompt and puts the
 * rewrite in the prompt box; "Use transcript as-is" puts the words there unchanged. They are the
 * same gesture with and without a model call — which is why "as-is" needs no request and is not a
 * dismissal.
 *
 * A promotion **appends** rather than replaces, and **empties the transcript**. Appending is the only
 * reading that cannot silently destroy typed work; emptying is the only one where a second round of
 * dictation does not promote the first round twice.
 *
 * **The prompt box is the draft.** It is what autosaves, what flushes, and what launches. The
 * transcript participates in none of that, which is also why a reload does not bring it back.
 *
 * ## The draft is the one optimistic thing on the page
 *
 * You type, the box is already right, and a debounced save follows. A failed save leaves the draft
 * marked dirty so the next edit retries — losing a keystroke to a 500 is not a thing a text box may
 * do. Everything else on this screen waits for the server and refetches.
 *
 * The `prompt-draft` hint fires on the client's own saves as well as another device's, so the echo
 * is deduped on `updatedAt`: the value a save answers with is byte-identical to the one a later read
 * gives, which is the whole reason the save's response is used rather than discarded. A hint that is
 * *not* our echo is another device, and it is adopted only when there is nothing local to lose.
 *
 * ## Flush-then-launch, and a failed flush aborts
 *
 * The draft is written synchronously before the launch, and a failure stops the launch with a
 * visible error. Two reasons to keep this even now, while the prompt is delivered inline and the
 * race it defends against is temporarily absent: the moment image attachments land, delivery
 * inverts back to *fetch* and the discipline has to already be there; and a draft that failed to
 * save is work about to be lost, which is worth aborting for on its own. **Launching with the wrong
 * prompt is worse than not launching.**
 *
 * ## Not signed in is said here, and answered in the Agents tab
 *
 * A launch refused because nobody has signed the harness in is not an error line: it has a next step,
 * and that step is a terminal. So the refusal goes to {@link ../agents/agent-sign-in#AgentSignIn},
 * the notice offers to open the sign-in terminal, and pressing it jumps to the Agents tab — which is
 * where this page renders a PTY, and where the same notice is already waiting. What this replaces is
 * the silence: the launch used to *become* that terminal, and this panel handed the caller a
 * `TERMINAL` command to attach a chat socket to.
 */
@Component({
  selector: 'app-prompt-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LevelMeter, QitsButton, SignInNotice],
  templateUrl: './prompt-panel.html',
  styleUrl: './prompt-panel.css',
})
export class PromptPanel {
  private readonly drafts = inject(PromptDraftApi);
  private readonly commandsApi = inject(CommandsApi);
  private readonly speech = inject(SpeechApi);
  private readonly events = inject(WorkspaceEvents);
  protected readonly picked = inject(PickedContext);
  private readonly nav = inject(FileNavigation);
  protected readonly signIn = inject(AgentSignIn);
  private readonly router = inject(Router);

  /** Which workspace's container to launch in, and whose draft to hold. */
  readonly workspaceRowId = input.required<number>();

  /** The workspace's stated goal. Host-side metadata the refinement request has to carry. */
  readonly preamble = input<string | null>(null);

  /** A chat was launched. The panel does not swap itself; the tab decides what it shows. */
  readonly launched = output<CommandDto>();

  /** The prompt box: the draft, and the only thing that is saved, flushed or launched. */
  protected readonly text = signal('');

  /**
   * The transcript box: what has been dictated, and nothing else.
   *
   * Deliberately not part of the draft. The composition blob's schema is prompt text, picked
   * snippets, code references and attachment ids — a half-dictated sentence is not work product,
   * and persisting it would make a restored draft offer back words the user already decided against.
   */
  protected readonly transcript = signal('');

  protected readonly save = signal<SaveState>('clean');
  protected readonly saveProblem = signal<string | null>(null);

  /** The draft that was on the server when this panel opened, if any. */
  protected readonly restoredAt = signal<string | null>(null);

  protected readonly refining = signal(false);
  protected readonly refineProblem = signal<string | null>(null);

  protected readonly launching = signal(false);
  protected readonly launchProblem = signal<string | null>(null);

  private readonly runtime = inject(SPEECH_RUNTIME);

  private readonly recorder = new SpeechRecorder(
    this.runtime,
    (audio) => this.speech.transcribe(audio),
    (text) => this.appendUtterance(text),
  );

  protected readonly recording = computed(() => this.recorder.state() === 'recording');
  protected readonly starting = computed(() => this.recorder.state() === 'starting');

  /**
   * Asked before the button is drawn rather than after it is pressed.
   *
   * A Record button that only explains itself once you have pressed it is a button that lies until
   * then, and this is the one capability check the answer to is known up front.
   */
  protected readonly unsupported = computed(
    () => !this.runtime.supported() || this.recorder.state() === 'unsupported',
  );
  protected readonly level = this.recorder.level;
  protected readonly transcribing = this.recorder.transcribing;
  protected readonly micProblem = this.recorder.problem;

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** What was last written, so the `prompt-draft` hint can tell our own echo from someone else's. */
  private lastWrittenAt: string | null = null;
  private loadedFor = 0;
  private seenHint = -1;

  private readonly draftHints = this.events.invalidations('prompt-draft');

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      untracked(() => {
        this.picked.use(workspaceRowId);
        if (this.loadedFor !== workspaceRowId) {
          this.loadedFor = workspaceRowId;
          void this.restore(workspaceRowId);
        }
      });
    });

    // The counter's *movement* is the signal, so the first run is skipped: the restore above is
    // already the initial read, and answering the effect's own first tick would double it.
    effect(() => {
      const hint = this.draftHints();
      untracked(() => {
        if (this.seenHint < 0) {
          this.seenHint = hint;
          return;
        }
        if (hint === this.seenHint) {
          return;
        }
        this.seenHint = hint;
        void this.reconcile(this.workspaceRowId());
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.clearTimer();
      this.recorder.dispose();
    });
  }

  // ---- composition ------------------------------------------------------------------------------

  protected readonly composition = computed<DraftComposition>(() => ({
    text: this.text(),
    references: this.picked.references(),
    elements: this.picked.elements(),
  }));

  /** Whether there is anything to launch with. An empty prompt is not a launch. */
  protected readonly composed = computed(() => serializePrompt(this.composition()).trim());

  protected readonly canLaunch = computed(
    () => this.composed().length > 0 && !this.launching() && !this.recording(),
  );

  /** Whether there is a transcript to promote. Both buttons appear and vanish together. */
  protected readonly canPromote = computed(
    () => this.transcript().trim().length > 0 && !this.refining(),
  );

  protected label(reference: CodeReference): string {
    return referenceLabel(reference);
  }

  /** How long ago the restored draft was written — "2h ago", the hint's whole content. */
  protected ago(iso: string): string {
    return relativeSince(iso);
  }

  /**
   * What the footer says about the draft.
   *
   * `clean` says nothing at all. A box that permanently announces "saved" is noise; the states worth
   * a word are the two where the server and the box disagree.
   */
  protected readonly saveLabel = computed(() => {
    switch (this.save()) {
      case 'pending':
        return 'Not saved yet';
      case 'saving':
        return 'Saving…';
      case 'dirty':
        return 'Not saved — the next edit retries';
      default:
        return '';
    }
  });

  protected onType(value: string): void {
    this.text.set(value);
    // The hint is about the draft that was found, and the first edit is the moment it stops being
    // someone else's work and becomes yours. Dictating does not count: the transcript is not the
    // draft, so it has not yet touched what the hint is about.
    this.restoredAt.set(null);
    this.scheduleSave();
  }

  protected onDictate(value: string): void {
    // No save, no hint, no debounce. The transcript is scratch until it is promoted.
    this.transcript.set(value);
  }

  protected insertReference(index: number): void {
    const reference = this.picked.references()[index];
    if (reference) {
      this.insert(referenceText(reference));
    }
  }

  /**
   * Open a picked reference in the viewer, at the lines it stands for.
   *
   * The designed consumer of the file browser's exact-range entry point, and it is one call: the
   * jump is a URL write, so it switches tabs, opens the file and paints the range through the same
   * path a pasted deep link takes. The chip is a link back to what it stands for — a row that could
   * only be pasted into a prompt would make the user find the code again by hand.
   */
  protected showReference(index: number): void {
    const reference = this.picked.references()[index];
    if (reference) {
      this.nav.openAt(reference.path, {
        startLine: reference.startLine,
        endLine: reference.endLine,
      });
    }
  }

  /**
   * Open a picked element's source file in the viewer.
   *
   * **The closest match, not the exact path.** A component map is a fact about the tree when it was
   * scanned, and a rename between the pick and the press must not become a dead link — so the file
   * browser seeds its name filter with the path exactly as if it had been typed, narrows, and lets
   * the user see *why*. A browser that silently jumped somewhere near where you asked would be worse
   * than one that missed.
   */
  /** The last segment, which is what fits on a chip. The full path is the title. */
  protected fileName(path: string): string {
    const at = path.lastIndexOf('/');
    return at === -1 ? path : path.slice(at + 1);
  }

  protected openSource(path: string): void {
    this.nav.openClosest(path);
  }

  protected insertElement(index: number): void {
    const element = this.picked.elements()[index];
    if (element) {
      this.insert(elementText(element));
    }
  }

  private insert(fragment: string): void {
    this.append(fragment, '\n\n');
  }

  /** One recognised utterance, onto the end of the transcript. Sentences, so a space joins them. */
  private appendUtterance(utterance: string): void {
    this.transcript.update((current) =>
      current.trim() ? `${current.trimEnd()} ${utterance}` : utterance,
    );
  }

  /**
   * Put text in the prompt box, which is a draft edit like any other.
   *
   * Appending rather than replacing is the whole of the safety here: a promotion arriving on top of
   * something the user typed must not be the way that typing disappears.
   */
  private append(fragment: string, separator: string): void {
    this.text.update((current) =>
      current.trim() ? `${current.trimEnd()}${separator}${fragment}` : fragment,
    );
    this.restoredAt.set(null);
    this.scheduleSave();
  }

  // ---- speech -----------------------------------------------------------------------------------

  protected async record(): Promise<void> {
    await this.recorder.start();
  }

  protected async stopRecording(): Promise<void> {
    await this.recorder.stop();
  }

  // ---- promotion --------------------------------------------------------------------------------

  /**
   * Rewrite the transcript into a prompt, and put the rewrite in the prompt box.
   *
   * One model call over the harness already installed in this container, and its meta-prompt says
   * exactly what it is for: fix speech-recognition artifacts, misheard words, filler, false starts
   * and self-corrections, preserve every technical detail, invent nothing. The transcript stays put
   * if the call fails — losing dictation to a failed rewrite would be the worst trade on the panel.
   */
  protected async refine(): Promise<void> {
    const transcript = this.transcript().trim();
    if (!transcript) {
      return;
    }
    this.refining.set(true);
    this.refineProblem.set(null);
    try {
      const prompt = await this.commandsApi.refinePrompt(
        this.workspaceRowId(),
        transcript,
        this.preamble(),
      );
      this.promote(prompt);
    } catch (error) {
      this.refineProblem.set(`The rewrite did not happen — ${describeError(error)}.`);
    } finally {
      this.refining.set(false);
    }
  }

  /** Promote the words exactly as spoken. The same gesture as Refine, without the model call. */
  protected useAsIs(): void {
    const transcript = this.transcript().trim();
    if (!transcript) {
      return;
    }
    this.refineProblem.set(null);
    this.promote(transcript);
  }

  /** Move the transcript into the prompt box: append there, empty here. */
  private promote(prompt: string): void {
    this.append(prompt.trim(), '\n\n');
    this.transcript.set('');
  }

  // ---- the draft --------------------------------------------------------------------------------

  private async restore(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    try {
      const draft = await this.drafts.draft(workspaceRowId);
      if (this.workspaceRowId() !== workspaceRowId || !draft) {
        return;
      }
      const composition = parseComposition(draft.content);
      this.text.set(composition.text);
      this.picked.restore(composition);
      this.lastWrittenAt = draft.updatedAt;
      this.restoredAt.set(draft.updatedAt);
      this.save.set('clean');
    } catch (error) {
      this.saveProblem.set(`The saved draft could not be read — ${describeError(error)}.`);
    }
  }

  /**
   * A `prompt-draft` hint arrived. Decide whether it was us.
   *
   * Our own save fires the same topic, so a blind refetch would fight the box on every keystroke's
   * debounce. The `updatedAt` a save answers with is byte-identical to the one a read gives, so it
   * is an exact echo test — and when the answer is *not* our echo it is another device, adopted only
   * if there is nothing local it would throw away. Anything else is a merge, and a text box is the
   * wrong place to invent one.
   */
  private async reconcile(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0 || this.save() !== 'clean') {
      return;
    }
    try {
      const draft = await this.drafts.draft(workspaceRowId);
      if (!draft || draft.updatedAt === this.lastWrittenAt || this.save() !== 'clean') {
        return;
      }
      const composition = parseComposition(draft.content);
      this.text.set(composition.text);
      this.picked.restore(composition);
      this.lastWrittenAt = draft.updatedAt;
      this.restoredAt.set(draft.updatedAt);
    } catch {
      // A failed reconcile leaves the box exactly as it was, which is the safe half of the trade.
    }
  }

  private scheduleSave(): void {
    this.save.set('pending');
    this.clearTimer();
    this.timer = setTimeout(() => void this.write(), DRAFT_DEBOUNCE_MS);
  }

  /** Write now, if anything is waiting. What the launch path calls before it launches. */
  protected async flush(): Promise<void> {
    if (this.save() === 'clean') {
      return;
    }
    this.clearTimer();
    await this.write();
  }

  private async write(): Promise<void> {
    this.clearTimer();
    const workspaceRowId = this.workspaceRowId();
    const composition = this.composition();
    this.save.set('saving');
    try {
      const draft = await this.drafts.save(
        workspaceRowId,
        JSON.stringify(composition),
        serializePrompt(composition),
      );
      this.lastWrittenAt = draft.updatedAt;
      // Only clean if nothing was typed while the request was out — otherwise the next debounce owns
      // it, and marking clean here would be the one way to actually lose a keystroke.
      if (this.save() === 'saving') {
        this.save.set('clean');
      }
      this.saveProblem.set(null);
    } catch (error) {
      this.save.set('dirty');
      this.saveProblem.set(`The draft is not saved — ${describeError(error)}.`);
    }
  }

  /** Throw the restored draft away. The hint's own action, and it clears the picks with it. */
  protected async discard(): Promise<void> {
    this.clearTimer();
    this.text.set('');
    this.picked.clear();
    this.restoredAt.set(null);
    this.save.set('clean');
    try {
      await this.drafts.discard(this.workspaceRowId());
      this.lastWrittenAt = null;
      this.saveProblem.set(null);
    } catch (error) {
      this.saveProblem.set(`The draft could not be discarded — ${describeError(error)}.`);
    }
  }

  // ---- launching --------------------------------------------------------------------------------

  /**
   * Flush, then launch as a chat.
   *
   * The flush is awaited and its failure is fatal to the launch. `deliverTaskPrompt` stays false and
   * the composed prompt rides `initialContext`: text, code references and picked elements are all
   * text, and the fetch path exists only for images, which are phase two.
   */
  protected async launchChat(): Promise<void> {
    if (!this.canLaunch()) {
      return;
    }
    this.launching.set(true);
    this.launchProblem.set(null);
    try {
      await this.flush();
      if (this.save() === 'dirty') {
        this.launchProblem.set(
          'The draft did not save, so nothing was launched — the agent would have read the wrong prompt. Try again.',
        );
        return;
      }
      const command = await this.commandsApi.launchAgent(this.workspaceRowId(), {
        scope: 'REPOSITORY',
        // One line of body, and the reason it matters: this request is **byte-identical to the
        // refining route's** in qits-projects-frontend — same scope, same mode, same composed
        // `initialContext` — so the workspace daemon serving both cannot tell an epic's chat from an
        // ad-hoc workspace's, and neither can anything downstream. Until both frontends name their
        // own surface, one configuration cannot be given to an epic's chat without giving it to
        // every ad-hoc workspace chat as well.
        surface: 'workspace.chat',
        mode: 'CHAT',
        initialContext: this.composed(),
        deliverTaskPrompt: false,
      });
      if (isSignInTerminal(command)) {
        // A daemon that still swaps the session for a login REPL. It is a `TERMINAL`, so attaching
        // this tab's conversation to it would attach a chat socket to a PTY and show nothing; the
        // notice goes up instead, and the terminal opens on a press.
        this.signIn.adopt(command);
        return;
      }
      this.launched.emit(command);
    } catch (error) {
      // Not signed in has a next step, so it is the sign-in surface's rather than an error line.
      if (!this.signIn.refuse(error)) {
        this.launchProblem.set(`The agent did not start — ${describeError(error)}.`);
      }
    } finally {
      this.launching.set(false);
    }
  }

  /**
   * The sign-in terminal is open — go to where it is drawn.
   *
   * A URL write, like every other cross-tab jump on this page, so a press and a pasted link take the
   * same path. It runs *after* the launch has answered: a jump to a tab with nothing in it would be
   * the same unexplained relocation this whole surface exists to end.
   */
  protected goToAgents(): void {
    // Written off the current URL rather than relative to an `ActivatedRoute`, the way the file
    // browser's jumps are: this panel is mounted deep inside a tab host, and the tab is a query
    // parameter on the route above it, so the whole write is "keep the URL, set `tab`".
    const tree = this.router.parseUrl(this.router.url);
    tree.queryParams = { ...tree.queryParams, tab: 'agents' };
    void this.router.navigateByUrl(tree);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
