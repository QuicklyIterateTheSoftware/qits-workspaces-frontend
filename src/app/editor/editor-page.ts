import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { QITS_NAVIGATION, QITS_REPOSITORIES, QITS_SCOPE, QitsButton } from '@qits/ui-components';
import type { EditorSessionDto } from '../api/dto';
import { WorkspacesApi } from '../api/workspaces-api';
import { Async } from '../ui/async';
import {
  IDLE,
  LOADING,
  describeError,
  failed,
  ready,
  serverMessage,
  statusOf,
  type Loadable,
} from '../ui/loadable';
import { BROWSER_LOCATION, editorOrigin } from './editor-origin';

/** How often the door is asked again while the editor is still coming up. */
export const EDITOR_POLL_MS = 2_000;

/** Which container verb is waiting on the server. Never "a mutation is pending". */
type Pending = 'stop' | 'recreate' | null;

/**
 * The editor: the platform's browser VS Code, and the wait while it comes up.
 *
 * **The page is a door and a waiting room, and then it is gone.** The editor is
 * `openvscode-server` on its own origin — `https://editor.<env>.<domain>/` — so the last thing this
 * component does is a *full* navigation out of the application. It is not an iframe and not a
 * route: the editor owns a whole origin, with its own service worker, its own history and its own
 * websockets, and a frame around it would buy nothing and cost all three.
 *
 * **`POST /workspaces/api/editor/ensure` is the entire protocol.** One idempotent door, asked on
 * arrival and then every two seconds: a fresh editor answers `201`, an existing one `200`, and the
 * same body says whether it answers requests yet. There is no separate status read, and this page
 * deliberately does not judge readiness from `editorState` — the service holds both the container
 * status and the daemon's report, and `editorReady` is where that judgement lives. The states are
 * what the wait *says* while it is false.
 *
 * **Nothing is torn down on the way out.** The editor rides a shared container: somebody else may
 * be in it, a coding agent may be running in it, and the reader leaving this page is usually the
 * reader *arriving* at the editor. So leaving cancels the poll and ends there — no stop, no delete.
 * The same rule the glances page states, for the same reason: a shared instance is not this page's
 * to end, and the one verb that ends it is a button somebody presses.
 *
 * **The door is unscoped, and the project scope is a folder convenience.** There is one editor for
 * the whole platform, holding every project's wrapper cloned side by side at `/workspace/<repo>`,
 * so the door is asked on arrival unconditionally and names nothing. That inverts the rule this
 * page shipped with: a project in the address used to decide whether there was an editor to ask
 * for at all, and now it decides only which directory the editor opens at — a `?folder=` appended
 * to the hand-off. Unscoped is the ordinary case and gets the same editor.
 *
 * **Stop and Recreate are the two ways out of a stuck editor**, and they are the container verbs
 * the status strip already offers, aimed at the workspace the door named. Recreate is refused with
 * a `400` unless the working tree is provably clean — this page cannot know that in advance, since
 * the door answers no `clean` field, so the refusal is surfaced as the sentence it is rather than
 * as a bare status.
 */
@Component({
  selector: 'app-editor-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, QitsButton],
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.css',
})
export class EditorPage {
  private readonly api = inject(WorkspacesApi);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly qitsRepositories = inject(QITS_REPOSITORIES);
  private readonly browser = inject(BROWSER_LOCATION);
  /**
   * The platform's own statement of this environment's authority — the same navigation document
   * every sidebar link is composed from. Optional because a bare spec of this component need not
   * stand the whole chrome up; a page without it simply keeps waiting for an address.
   */
  private readonly navigation = inject(QITS_NAVIGATION, { optional: true });

  protected readonly session = signal<Loadable<EditorSessionDto>>(IDLE);
  protected readonly pending = signal<Pending>(null);

  /** A container verb's refusal, in the service's words. Never overwrites the wait's own error. */
  protected readonly problem = signal<string | null>(null);

  /** Set by Stop, and by nothing else: the poll is halted because somebody halted it. */
  protected readonly stopped = signal(false);

  /** The hand-off has been made. The browser is leaving; nothing after it is worth drawing. */
  protected readonly leaving = signal(false);

  /** The project the address names, if it names one — which folder the editor opens at. */
  protected readonly projectSlug = computed(() => this.qitsScope.scope().project);

  /**
   * The **name** of the scoped project's wrapper repository, which is the directory that project's
   * checkout sits in inside the shared editor — `/workspace/<name>`.
   *
   * The name and not the id, and not the project slug: the container clones each wrapper under the
   * repository's own name, so project `qits` is at `/workspace/qits-qits`. Which row that is, is
   * the overview's rule reused — the wrapper is the row an aggregate workspace branches, and so the
   * row holding a project's whole checkout, submodules and all. A repository segment in the address
   * says which page the reader came in through and never which directory this is.
   *
   * `undefined` while the chrome's repository listing has not answered, and for a wrapper it does
   * not carry a row for. Both are non-events here: the folder is a convenience, so its absence
   * costs the reader a `cd` and nothing else — see {@link editorUrl}.
   */
  protected readonly wrapperRepositoryName = computed(() => {
    if (!this.qitsScope.scope().project) {
      return undefined;
    }
    const wrapperId = this.qitsRepositories.wrapperRepositoryId();
    if (!wrapperId) {
      return undefined;
    }
    return this.qitsRepositories.repositories()?.find((row) => row.id === wrapperId)?.name;
  });

  /**
   * Where the reader is being sent, or null while the platform has not stated its origin yet.
   *
   * The origin is the platform's one shared editor. A `?folder=` is appended when the address names
   * a project *and* its wrapper's name is known, so the editor opens at that project's checkout
   * instead of at the container's root.
   *
   * **The folder is a convenience and never a gate.** A listing that has not answered, or that
   * carries no row for the wrapper, sends the reader to the bare origin rather than making them
   * wait: being in the editor one directory up beats being on this page, and every project is
   * there to open by hand anyway.
   */
  protected readonly editorUrl = computed(() => {
    const origin = editorOrigin(
      this.navigation?.tree()?.projectOrigin,
      this.navigation?.tree()?.environmentOrigin,
    );
    if (!origin) {
      return null;
    }
    const name = this.wrapperRepositoryName();
    // `editorOrigin` ends in `/`, so the query goes straight on the end.
    return name ? `${origin}?folder=${encodeURIComponent(`/workspace/${name}`)}` : origin;
  });

  /** The editor ran and stopped. A waiting state would wait forever, so it is its own surface. */
  protected readonly ended = computed(() => this.answer()?.editorState === 'ENDED');

  /** What the wait says about itself, while it is still a wait. */
  protected readonly waitLabel = computed(() => {
    const answer = this.answer();
    if (!answer) {
      return 'Starting the editor…';
    }
    if (answer.editorState === 'RUNNING') {
      return 'The editor is running — waiting for it to answer…';
    }
    return answer.containerStatus === 'RUNNING'
      ? 'The container is up. Starting the editor…'
      : `Starting the container (${answer.containerStatus.toLowerCase()})…`;
  });

  /** The workspace the door named, which is what the two container verbs act on. */
  protected readonly workspaceId = computed(() => this.answer()?.workspaceId ?? null);

  private readonly answer = computed(() => {
    const state = this.session();
    return state.kind === 'ready' ? state.value : null;
  });

  /** The next poll, when one is armed. Cleared on the way out — see the class note. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  private handedOff = false;

  constructor() {
    // Fired once, here, and not from an effect watching the scope: the door names nothing, so there
    // is no listing to wait for and nothing that could make the request a guess.
    void this.ensure();

    // Cancel the poll, and do nothing else. The editor is shared and outlives this page.
    inject(DestroyRef).onDestroy(() => this.cancelPoll());
  }

  /** Ask again from the top: what Retry presses, and what Start after a stop presses. */
  protected retry(): void {
    this.stopped.set(false);
    this.problem.set(null);
    void this.ensure();
  }

  /**
   * Stop the container the editor rides.
   *
   * The poll is cancelled *first*: `ensure` is a door that starts what is missing, so one round
   * arriving after the stop would put the container straight back up.
   */
  protected async stop(): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId || this.pending()) return;
    this.cancelPoll();
    this.pending.set('stop');
    this.problem.set(null);
    try {
      await this.api.stopContainer(workspaceId);
      this.stopped.set(true);
    } catch (error) {
      this.problem.set(describeError(error));
      this.resume();
    } finally {
      this.pending.set(null);
    }
  }

  /**
   * Throw the container away and build a fresh one, then wait for the editor again.
   *
   * The `400` this can answer is the clean-working-tree guard, and it is the whole reason the
   * button is offered without being disabled: the editor door reports no `clean` field, so unlike
   * the status strip this page cannot know the answer before it asks. The refusal is rendered as
   * the sentence it is.
   */
  protected async recreate(): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId || this.pending()) return;
    this.cancelPoll();
    this.pending.set('recreate');
    this.problem.set(null);
    try {
      await this.api.recreateContainer(workspaceId);
      this.stopped.set(false);
      this.resume();
    } catch (error) {
      this.problem.set(this.refusal(error));
      this.resume();
    } finally {
      this.pending.set(null);
    }
  }

  /** One round of the door, and whatever the answer implies: hand off, stop, or ask again. */
  private async ensure(): Promise<void> {
    this.cancelPoll();
    if (this.session().kind !== 'ready') {
      this.session.set(LOADING);
    }
    try {
      const answer = await this.api.ensureEditor();
      this.session.set(ready(answer));
      if (answer.editorReady) {
        if (this.editorUrl()) {
          this.handOff();
          return;
        }
        // Ready, but the navigation document has stated no origin to compose against yet — the
        // address is composed from it, so ask again shortly rather than stranding the reader.
        this.schedule();
        return;
      }
      // An ended editor is not a slow one. Waiting on it would wait forever, so the poll stops and
      // the surface offers the press that starts a new one.
      if (answer.editorState !== 'ENDED') {
        this.schedule();
      }
    } catch (error) {
      this.session.set(failed(error));
    }
  }

  /** Leave the application for the editor's own origin. Once, and never through the router. */
  private handOff(): void {
    const url = this.editorUrl();
    if (!url || this.handedOff) return;
    this.handedOff = true;
    this.leaving.set(true);
    this.browser.assign(url);
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ensure();
    }, EDITOR_POLL_MS);
  }

  /** Pick the wait back up where a verb interrupted it, unless it has nothing left to wait for. */
  private resume(): void {
    if (this.stopped() || this.handedOff) return;
    this.schedule();
  }

  private cancelPoll(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The recreate guard's own words, said as a refusal rather than as a status code. */
  private refusal(error: unknown): string {
    if (statusOf(error) !== 400) {
      return describeError(error);
    }
    const said = serverMessage(error instanceof HttpErrorResponse ? error.error : null);
    return (
      'Recreate needs a working tree the service can prove is clean, and this one is not: ' +
      `${said ?? 'the service refused it'}. Recreating would throw those changes away, so commit ` +
      'or discard them in the workspace first.'
    );
  }
}
