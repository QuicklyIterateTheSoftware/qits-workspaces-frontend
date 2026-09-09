import { Injectable, computed, inject, signal } from '@angular/core';
import { CommandsApi, type AgentType, type CommandDto } from '../../api/commands-api';
import { describeError, serverMessage } from '../../ui/loadable';

/** A launch that was refused because nobody has signed the harness in. */
export interface SignedOut {
  /** Which harness has nobody signed in, when the refusal named one. */
  readonly harness: AgentType | null;
  /** The refusal in the daemon's own words — it names the harness and where to sign in. */
  readonly message: string;
}

/**
 * The sentences a "nobody is signed in" refusal is recognised by.
 *
 * **Matched on the message rather than on the status, and that is a deliberate choice with a cost.**
 * The harness library throws a *typed* refusal (`AgentNotSignedInException`, task 7c44058f, landed)
 * carrying exactly this text, but the workspace daemon has not been cut over to the library yet and
 * so has no mapping for it — its agent routes turn `InvalidCommandRequestException` into a 400,
 * `CommandNotFoundException` into a 404 and *everything else into a 500 whose message is deliberately
 * not returned*. Pinning a status here would therefore be pinning a number nobody has chosen; the
 * message is the one part of the refusal the library actually fixes.
 *
 * The consequence to reconcile when the daemon lands: it must map the refusal to a **4xx carrying the
 * exception's message**. Left as the default 500, the browser is handed "Internal error" and this
 * page cannot tell a signed-out platform from a broken one — which is the exact blindness this
 * feature removes.
 */
const NOT_SIGNED_IN = /nobody has signed|not signed in|sign-?in terminal/i;

/** Read the harness out of the refusal's own words. Absent is a state, not a failure. */
function harnessNamed(message: string): AgentType | null {
  if (/kimi/i.test(message)) {
    return 'KIMI';
  }
  return /claude/i.test(message) ? 'CLAUDE' : null;
}

/**
 * Whether a failed launch was refused for want of a sign-in, and what it said.
 *
 * Null for every other failure, so a caller falls through to its ordinary error handling: a refusal
 * this cannot recognise must read as the daemon's own sentence, never as a sign-in prompt for a
 * problem signing in would not fix.
 */
export function signedOutRefusal(error: unknown): SignedOut | null {
  const message = serverMessage((error as { error?: unknown } | null)?.error);
  if (!message || !NOT_SIGNED_IN.test(message)) {
    return null;
  }
  return { harness: harnessNamed(message), message };
}

/**
 * Whether a command is the sign-in terminal rather than a session.
 *
 * **Lineage alone is not enough, and that is a real trap.** A login terminal has no session lineage —
 * true, but a *fresh Kimi* launch also arrives with none, because Kimi cannot pin a session id and
 * the `SessionStart` hook reports it later. Treating that as a sign-in would put a notice over a
 * perfectly good agent. So the name the daemon gives the login command is checked as well, and both
 * have to agree.
 *
 * **A transitional reader, and it is dated.** Once the workspace daemon runs the harness library, a
 * launch against a signed-out harness *refuses* — it can no longer answer with a terminal at all, and
 * {@link signedOutRefusal} is the whole story. Until then the deployed daemon still performs the
 * substitution this feature exists to remove, and a client that did not notice would attach a
 * conversation to a login prompt and say nothing. So it is recognised, and it is not attached to:
 * {@link AgentSignIn.adopt} turns it back into the offer it should have been.
 */
export function isSignInTerminal(command: CommandDto): boolean {
  // An absent lineage reads as an empty one. The daemon always sends the array, and a client that
  // took its word for that would throw on the one answer it most needs to classify.
  const lineage = command.agentSessions ?? [];
  return lineage.length === 0 && /sign-in$/i.test((command.actionName ?? '').trim());
}

/**
 * "Nobody is signed in", and the door out of it — shared by the two panels that launch.
 *
 * ## What this replaces
 *
 * An unauthenticated harness used to turn the session you asked for into something else: the launch
 * answered a bare login REPL, and the caller attached to it exactly as it would to a real session.
 * You asked for a chat about this workspace and got a sign-in terminal, with nothing in the answer
 * saying so. The harness library refuses now instead, naming the harness, and **this holds that
 * refusal and offers the terminal as a press** — which is the entire difference: the same terminal,
 * opened deliberately, by a user who was told what it is.
 *
 * ## Why it is a service rather than a signal on a panel
 *
 * Both surfaces launch — the Chat tab through the prompt panel, the Agents tab through {@link
 * ./agent-session#AgentSession} — and both meet the same wall for the same reason: **one sign-in
 * serves the whole shared credential volume**, so being signed out is a fact about the container and
 * not about the tab you happened to press in. Holding it once means the Chat tab's refusal is still
 * on screen when you arrive at the Agents tab to complete it, which is exactly the journey the offer
 * sends you on.
 *
 * The terminal itself is rendered by the Agents tab, because that is the page's one PTY. Opening it
 * is an ordinary launch — a `TERMINAL` command like any other — and everything after the press is the
 * machinery that already existed.
 */
@Injectable({ providedIn: 'root' })
export class AgentSignIn {
  private readonly api = inject(CommandsApi);

  private readonly refusalState = signal<SignedOut | null>(null);
  private readonly terminal = signal<string | null>(null);
  private readonly shown = signal(false);
  private readonly opening = signal(false);
  private readonly problemText = signal<string | null>(null);

  /** The refusal on hand, or null when nothing has been refused for want of a sign-in. */
  readonly refusal = this.refusalState.asReadonly();

  /** The sign-in terminal there is, opened or merely spawned. */
  readonly commandId = this.terminal.asReadonly();

  /**
   * The sign-in terminal to **render**, which is not the same question.
   *
   * A terminal the daemon spawned behind a launch's back exists without anybody having asked to see
   * it, and putting it on screen is precisely the drop-in this feature removes. So it is held, and
   * this stays null until somebody presses.
   */
  readonly visibleCommandId = computed(() => (this.shown() ? this.terminal() : null));

  /** Whether the door is being opened. */
  readonly busy = this.opening.asReadonly();

  /** What went wrong opening it, in the daemon's own words where it had any. */
  readonly problem = this.problemText.asReadonly();

  /** Whether there is something to say: a refusal to show, or a terminal already on screen. */
  readonly showing = computed(() => this.refusalState() !== null || this.terminal() !== null);

  /**
   * Forget everything. Called when the page points at another workspace — a refusal belongs to one
   * container's harness, and carrying it across would report the wrong workspace as signed out.
   */
  reset(): void {
    this.refusalState.set(null);
    this.terminal.set(null);
    this.shown.set(false);
    this.problemText.set(null);
    this.opening.set(false);
  }

  /**
   * Record a launch failure if it was a sign-in refusal, and answer whether it was.
   *
   * The caller keeps its own error surface for everything else: a `false` here means "this is not
   * mine, say what the daemon said".
   */
  refuse(error: unknown): boolean {
    const refusal = signedOutRefusal(error);
    if (!refusal) {
      return false;
    }
    this.refusalState.set(refusal);
    return true;
  }

  /**
   * Take a login terminal a launch answered with instead of a session — the deployed daemon's
   * substitution, until it runs the library that refuses.
   *
   * The terminal is already spawned, so it is adopted rather than launched again, and it is
   * **presented rather than attached**: the notice goes up with the same words the refusal carries,
   * and the terminal only appears once somebody presses to open it.
   */
  adopt(command: CommandDto): void {
    this.refusalState.set({
      harness: harnessNamed(command.actionName),
      message:
        'Nobody has signed this workspace’s coding agent in on the shared credential volume, so the' +
        ' session could not start. The sign-in terminal is ready to open.',
    });
    this.terminal.set(command.id);
    this.shown.set(false);
    this.opening.set(false);
  }

  /**
   * Open the sign-in terminal, and show it. A press, always.
   *
   * Two things it will not do twice. It does not launch a second terminal when one already exists —
   * the volume needs one OAuth, not one per press, and two REPLs would race for the same credential
   * file — so a terminal that was spawned behind a launch's back is *revealed* rather than replaced.
   * And it does not show anything a launch failed to open: a jump to a terminal that is not there
   * would be the same "something happened, somewhere" this whole surface exists to end.
   */
  async open(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0 || this.opening()) {
      return;
    }
    if (this.terminal() !== null) {
      this.shown.set(true);
      return;
    }
    this.opening.set(true);
    this.problemText.set(null);
    try {
      const command = await this.api.launchSignIn(
        workspaceRowId,
        this.refusalState()?.harness ?? undefined,
      );
      this.terminal.set(command.id);
      this.shown.set(true);
    } catch (error) {
      this.problemText.set(`The sign-in terminal did not open — ${describeError(error)}.`);
    } finally {
      this.opening.set(false);
    }
  }

  /**
   * The terminal has exited: drop it, and the refusal with it.
   *
   * **Nothing is replayed.** The launch that was refused used to be re-issued the moment the login
   * terminal closed, which was a reasonable thing to do when the terminal had been conjured in place
   * of that launch — the user never asked for it and was owed what they did ask for. Opened
   * deliberately, it is not an interruption to make good on: a sign-in that failed would relaunch
   * into the same wall, so the next session starts where every other one does, at a press.
   */
  finished(): void {
    this.terminal.set(null);
    this.shown.set(false);
    this.refusalState.set(null);
  }
}
