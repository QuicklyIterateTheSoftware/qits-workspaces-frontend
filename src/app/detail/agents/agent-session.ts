import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AgentsApi, type AgentSessionNodeDto, type AvailableAgentsDto } from '../../api/agents-api';
import {
  CommandsApi,
  type AgentType,
  type CommandDto,
  type LaunchAgentRequest,
} from '../../api/commands-api';
import { WEB_SOCKET_FACTORY } from '../../api/web-socket';
import { WorkspaceCommands } from '../../api/workspace-commands';
import { WorkspaceDaemonApi } from '../../api/workspace-daemon-api';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';
import { AgentSignIn, isSignInTerminal } from './agent-sign-in';
import { EMPTY_TERMINAL_FRAMES, TerminalSocket } from './terminal-socket';

/**
 * Where the embedded session has landed.
 *
 * The four branches are the spec's resolution order, plus the one special case and the two states
 * that are not a branch at all — `resolving` while the reads are in flight, and `unavailable` when
 * the container is not there to be asked.
 */
export type SessionBranch =
  | { readonly kind: 'resolving' }
  /** 1 — a running interactive agent run, wherever it was started. */
  | { readonly kind: 'attached'; readonly commandId: string }
  /** 2 — a running chat owns the conversation, so this tab defers to it. */
  | { readonly kind: 'deferred'; readonly commandId: string }
  /** The sign-in terminal somebody opened, rendered where a session would be. */
  | { readonly kind: 'signin'; readonly commandId: string }
  /** 4 — history exists and nothing is running, so nothing happens without a press. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The statuses that mean the container is not answering, as opposed to answering "no". */
const UNREACHABLE: readonly number[] = [0, 502, 503, 504];

/**
 * The embedded agent session: what it resolves to, and the socket it is attached through.
 *
 * ## The resolution order, and the rule under it
 *
 * On first selection — never on page load, because a session is expensive to materialise — this
 * resolves in exactly this order:
 *
 * 1. **A running interactive agent run → attach**, wherever it was started.
 * 2. **A running chat → defer**, with a jump link. Not a launch: a concurrent resume of the same
 *    session is the exact collision session-pinning exists to prevent.
 * 3. **No session history at all → launch fresh.**
 * 4. **History exists but nothing is running → idle on an explicit choice.**
 *
 * **Resuming is never automatic, and branch 4 is the whole reason this class is written down.** The
 * recorded last session can be gone from the agent's own state — a re-materialised container, pruned
 * volume state — and auto-resuming a vanished id exits instantly with "no conversation found", in a
 * loop the user never asked for. The daemon defends the same line from its side by refusing a resume
 * of a session this container does not own. A finished run does not auto-relaunch either, because a
 * crashing agent would relaunch forever. Every resume here starts at a press.
 *
 * ## Every launch names its surface
 *
 * Start, resume and fork all send `surface: "workspace.agent"`, and it is one line of body with a
 * reason worth the paragraph: this request is **byte-identical to the refining route's** in
 * qits-projects-frontend — same scope, same mode, same everything — so the daemon serving both cannot
 * tell an epic's agent tab from an ad-hoc workspace's. Until both frontends send their own key, a
 * configuration given to `epic.agent` is given to every workspace agent on the platform as well.
 *
 * ## Not signed in is an answer, not a substitution
 *
 * A launch against a harness nobody has signed in is **refused**, and the refusal is held by {@link
 * ./agent-sign-in#AgentSignIn} so the panel can say so and offer the sign-in terminal as a press. It
 * used to be swapped instead: `POST /agents` answered a login terminal, this class held the launch it
 * had interrupted, and re-issued it when the terminal exited. That machinery is gone with the swap it
 * existed to paper over — a terminal opened on purpose is not an interruption to make good on, and a
 * relaunch that meets the same wall is the launch loop the cap was there to stop.
 *
 * The terminal is still rendered here, because this is the page's one PTY: opening it produces an
 * ordinary `TERMINAL` command, and {@link SessionBranch} carries it exactly as it carries a session.
 */
@Injectable({ providedIn: 'root' })
export class AgentSession {
  private readonly agents = inject(AgentsApi);
  private readonly commandsApi = inject(CommandsApi);
  private readonly entry = inject(WorkspaceCommands);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly openSocket = inject(WEB_SOCKET_FACTORY);
  private readonly document = inject(DOCUMENT);
  private readonly signIn = inject(AgentSignIn);

  private readonly workspaceRowId = signal(0);

  private readonly sessionState = signal<Loadable<readonly AgentSessionNodeDto[]>>(IDLE);
  private readonly harnesses = signal<AvailableAgentsDto | null>(null);

  /** The command this page launched or resumed, which is attachable before any lineage is reported. */
  private readonly ownCommandId = signal<string | null>(null);

  private readonly inFlight = signal(false);
  private readonly problemText = signal<string | null>(null);

  /** Which workspace has already had its one automatic fresh launch. Branch 3 fires once, ever. */
  private autoLaunchedFor: number | null = null;

  /**
   * The attachment, as a signal rather than a field.
   *
   * It is read *through* by {@link frames} and {@link link}, so replacing the socket re-points both
   * without copying anything: a computed that reads `socketRef()?.frames()` re-tracks the new
   * socket's signal the moment the reference changes. Mirroring the screen into a second signal
   * would be one more thing to keep in step, for no reader.
   */
  private readonly socketRef = signal<TerminalSocket | null>(null);
  private socketFor: string | null = null;

  /** The session lineage, as the daemon's nested tree. */
  readonly sessions = this.sessionState.asReadonly();

  /** The harnesses this container can launch. Only a *fresh* launch may pick one. */
  readonly available = this.harnesses.asReadonly();

  /** Whether a launch, a resume or a fork is in flight. */
  readonly launching = this.inFlight.asReadonly();

  /** What went wrong, in the daemon's own words where it had any. */
  readonly problem = this.problemText.asReadonly();

  /** The attached terminal's raw PTY frames and link state. */
  readonly frames = computed(() => this.socketRef()?.frames() ?? EMPTY_TERMINAL_FRAMES);
  readonly link = computed(() => this.socketRef()?.status() ?? 'disconnected');

  constructor() {
    effect(() => this.driveSocket(this.branch()));
    effect(() => this.forgetFinishedSignIn());
    effect(() => this.autoLaunch());
  }

  // ---- what is on screen -------------------------------------------------------------------

  private readonly commandList = computed<readonly CommandDto[]>(() => {
    const state = this.entry.commands();
    return state.kind === 'ready' ? state.value : [];
  });

  /**
   * The run this tab is attached to.
   *
   * Two ways to be one, and the second is not redundant: a command *this page* launched is
   * attachable the instant it exists, before the harness has reported a session — which is the only
   * way a fresh Kimi launch is ever attachable at all, since Kimi cannot pin a session id up front.
   */
  private readonly agentRun = computed<CommandDto | null>(() => {
    const commands = this.commandList();
    const own = this.ownCommandId();
    const mine = commands.find((command) => command.id === own && command.status === 'RUNNING');
    if (mine && !isSignInTerminal(mine)) {
      return mine;
    }
    return (
      commands.find(
        (command) =>
          command.kind === 'TERMINAL' &&
          command.status === 'RUNNING' &&
          command.agentSessions.length > 0,
      ) ?? null
    );
  });

  /** Whether anything at all owns this workspace's conversation — the Resume buttons' gate. */
  readonly ownsConversation = computed(
    () => this.agentRun() !== null || this.entry.runningChat() !== null,
  );

  /** The session the attached run is driving. In `agentSessions` the **last** entry is the current one. */
  readonly liveSessionId = computed<string | null>(() => {
    const run = this.agentRun();
    if (!run || run.agentSessions.length === 0) {
      return null;
    }
    return run.agentSessions[run.agentSessions.length - 1].sessionId;
  });

  /**
   * The session a Resume in the idle state would continue, and where its transcript was written.
   *
   * Read off the command list rather than off the tree, because the list is ordered by *when it ran*
   * and the tree is ordered by lineage — the newest session is not always the newest root, and
   * "resume the last thing" has to mean the last thing.
   */
  readonly lastSession = computed<{ sessionId: string; transcriptPath?: string } | null>(() => {
    for (const command of this.commandList()) {
      const sessions = command.agentSessions;
      if (sessions.length > 0) {
        const ref = sessions[sessions.length - 1];
        return {
          sessionId: ref.sessionId,
          ...(ref.transcriptPath ? { transcriptPath: ref.transcriptPath } : {}),
        };
      }
    }
    return null;
  });

  /** Whether anything has ever run an agent here. Branch 3's only question. */
  private readonly hasHistory = computed(() => {
    const sessions = this.sessionState();
    if (sessions.kind === 'ready' && sessions.value.length > 0) {
      return true;
    }
    return this.commandList().some((command) => command.agentSessions.length > 0);
  });

  /** Where the tab has landed. Everything else on it is drawn from this. */
  readonly branch = computed<SessionBranch>(() => {
    const commands = this.entry.commands();
    if (commands.kind === 'error') {
      return {
        kind: 'unavailable',
        message: UNREACHABLE.includes(commands.status)
          ? 'The container is not answering, so there is no session to resolve. The agent surface lives inside it.'
          : 'The command list could not be read, so this tab cannot tell what is running.',
      };
    }
    if (commands.kind !== 'ready' || this.sessionState().kind === 'loading') {
      return { kind: 'resolving' };
    }

    // A sign-in terminal somebody opened outranks the resolution: it is what is on screen, and the
    // session it stands in front of cannot start until it is done anyway.
    const signInCommandId = this.signIn.visibleCommandId();
    if (signInCommandId) {
      const command = this.commandList().find((entry) => entry.id === signInCommandId);
      if (!command || command.status === 'RUNNING') {
        return { kind: 'signin', commandId: signInCommandId };
      }
      // It has exited. Nothing is replayed; the effect below drops it and this falls through to the
      // ordinary resolution, which is the idle choice a fresh session starts from.
    }

    const run = this.agentRun();
    if (run) {
      return { kind: 'attached', commandId: run.id };
    }
    const chat = this.entry.runningChat();
    if (chat) {
      return { kind: 'deferred', commandId: chat.id };
    }
    if (!this.hasHistory()) {
      // Branch 3. The launch is fired by an effect; until it answers this is still resolving.
      return this.autoLaunchedFor === this.workspaceRowId() && !this.inFlight()
        ? { kind: 'idle' }
        : { kind: 'resolving' };
    }
    return { kind: 'idle' };
  });

  /** The default harness for a fresh launch, or null until the list has been read. */
  readonly defaultAgent = computed<AgentType | null>(() => this.harnesses()?.defaultAgent ?? null);

  // ---- what it does ------------------------------------------------------------------------

  /**
   * Point at a workspace, and read what resolution needs.
   *
   * Idempotent for the same id. A different id drops everything: an attached socket, a pending
   * replay and a session list all belong to one container, and none of them means anything in
   * another.
   */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.detachSocket();
    this.workspaceRowId.set(workspaceRowId);
    this.ownCommandId.set(null);
    this.signIn.reset();
    this.problemText.set(null);
    this.autoLaunchedFor = null;
    this.harnesses.set(null);
    this.sessionState.set(workspaceRowId > 0 ? LOADING : IDLE);
    this.entry.use(workspaceRowId);
    if (workspaceRowId > 0) {
      void this.loadSessions(workspaceRowId);
      void this.loadHarnesses(workspaceRowId);
    }
  }

  /** Let go of the socket. The run keeps running: closing detaches, it never terminates. */
  detach(): void {
    this.detachSocket();
  }

  /** Re-read the lineage. Called on a `commands` hint while the tab is showing, and after a launch. */
  async refreshSessions(): Promise<void> {
    await this.loadSessions(this.workspaceRowId());
  }

  /** Start a brand-new session. The one launch where the harness may be chosen. */
  async startFresh(agentType?: AgentType): Promise<void> {
    await this.launch({
      scope: 'REPOSITORY',
      surface: 'workspace.agent',
      mode: 'INTERACTIVE',
      ...(agentType ? { agentType } : {}),
    });
  }

  /**
   * Continue a recorded session, or branch it.
   *
   * **Only ever from a press.** And `fork` is never sent without `resumeSessionId`: the daemon
   * refuses that pairing with a 400, and sending it would be this client asking for an answer it
   * already knows.
   */
  async resume(sessionId: string, fork = false): Promise<void> {
    if (!sessionId) {
      return;
    }
    await this.launch({
      scope: 'REPOSITORY',
      surface: 'workspace.agent',
      mode: 'INTERACTIVE',
      resumeSessionId: sessionId,
      ...(fork ? { fork: true } : {}),
    });
  }

  /** Type into the attached PTY. */
  send(data: string): void {
    this.socketRef()?.send(data);
  }

  /** Tell the PTY its size. */
  resize(cols: number, rows: number): void {
    this.socketRef()?.resize(cols, rows);
  }

  /** Try the attachment again after the backoff budget was spent. */
  rearm(): void {
    this.socketRef()?.rearm();
  }

  clearProblem(): void {
    this.problemText.set(null);
  }

  // ---- the machinery -----------------------------------------------------------------------

  private async launch(request: LaunchAgentRequest): Promise<void> {
    const workspaceRowId = this.workspaceRowId();
    if (workspaceRowId <= 0 || this.inFlight()) {
      return;
    }
    this.inFlight.set(true);
    this.problemText.set(null);
    try {
      const command = await this.commandsApi.launchAgent(workspaceRowId, request);
      if (isSignInTerminal(command)) {
        // Not a session: a login terminal, from a daemon that still substitutes one. It is *not*
        // attached to — the notice goes up with the same words the refusal carries, and the terminal
        // appears when somebody presses to open it.
        this.signIn.adopt(command);
        this.ownCommandId.set(null);
      } else {
        this.ownCommandId.set(command.id);
      }
      await Promise.all([this.entry.refresh(), this.refreshSessions()]);
    } catch (error) {
      // A refusal for want of a sign-in is the sign-in surface's, not an error line: it has a next
      // step, and "⚠ nobody is signed in" with nothing to press would be the old silence in words.
      if (!this.signIn.refuse(error)) {
        this.problemText.set(describeLaunch(error));
      }
    } finally {
      this.inFlight.set(false);
    }
  }

  /**
   * Branch 3, fired once per workspace.
   *
   * A guard rather than a condition, because the condition it watches — "no history" — is briefly
   * true again between a launch and the list that proves it happened, and a second launch there
   * would leave two agents in one workspace.
   */
  private autoLaunch(): void {
    const workspaceRowId = this.workspaceRowId();
    const commands = this.entry.commands();
    const sessions = this.sessionState();
    if (workspaceRowId <= 0 || commands.kind !== 'ready' || sessions.kind !== 'ready') {
      return;
    }
    // Nothing is launched into a signed-out harness or over an open sign-in terminal: the first
    // would be refused on every pass, and the second is the door being held for the launch anyway.
    if (this.hasHistory() || this.ownsConversation() || this.signIn.showing()) {
      return;
    }
    if (this.autoLaunchedFor === workspaceRowId) {
      return;
    }
    this.autoLaunchedFor = workspaceRowId;
    untracked(() => void this.startFresh());
  }

  /**
   * The sign-in terminal exited: let go of it, and of the refusal it was opened for.
   *
   * **And nothing else.** This is where the launch the terminal interrupted used to be re-issued,
   * with a cap on how often, because the terminal had been conjured in place of that launch and the
   * user was owed the session they actually asked for. A terminal opened on a press is not an
   * interruption: the next session starts where every other one does, at the idle choice below.
   */
  private forgetFinishedSignIn(): void {
    const signInCommandId = this.signIn.commandId();
    const commands = this.entry.commands();
    if (!signInCommandId || commands.kind !== 'ready') {
      return;
    }
    const command = this.commandList().find((entry) => entry.id === signInCommandId);
    if (!command || command.status === 'RUNNING') {
      return;
    }
    untracked(() => this.signIn.finished());
  }

  /**
   * One socket, keyed by command id.
   *
   * Keying it is the whole discipline: a relaunch is a *new* command, and reusing a socket bound to
   * a dead process is how a terminal ends up permanently showing someone else's exit.
   */
  private driveSocket(branch: SessionBranch): void {
    const wanted = branch.kind === 'attached' || branch.kind === 'signin' ? branch.commandId : null;
    if (wanted === this.socketFor) {
      return;
    }
    untracked(() => {
      this.detachSocket();
      if (!wanted) {
        return;
      }
      const url = this.daemon.socketUrl(
        this.workspaceRowId(),
        `/terminal/commands/${encodeURIComponent(wanted)}`,
      );
      const socket = new TerminalSocket(url, this.openSocket, this.document);
      this.socketFor = wanted;
      this.socketRef.set(socket);
      socket.connect();
    });
  }

  private detachSocket(): void {
    this.socketRef()?.close();
    this.socketRef.set(null);
    this.socketFor = null;
  }

  private async loadSessions(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      this.sessionState.set(IDLE);
      return;
    }
    try {
      const sessions = await this.agents.sessions(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.sessionState.set(ready(sessions));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.sessionState.set(failed(error));
      }
    }
  }

  /** Once per container: the resolved default cannot change under a running one. */
  private async loadHarnesses(workspaceRowId: number): Promise<void> {
    try {
      const available = await this.agents.available(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.harnesses.set(available);
      }
    } catch {
      // A missing harness list costs the picker and nothing else: a launch with no `agentType`
      // takes the container's own default, which is the same answer this read would have given.
    }
  }
}

/** A launch failure, preferring the daemon's own sentence — it explains refusals this cannot. */
function describeLaunch(error: unknown): string {
  const body = (error as { error?: { message?: string } } | null)?.error;
  if (body && typeof body.message === 'string' && body.message.trim()) {
    return body.message;
  }
  const status = (error as { status?: number } | null)?.status ?? 0;
  if (UNREACHABLE.includes(status)) {
    return 'The container is not answering — an agent can only be launched inside a running one.';
  }
  return 'The launch was refused.';
}
