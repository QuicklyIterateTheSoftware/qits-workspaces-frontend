import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's command and coding-agent surface, hand-written from
 * `daemons/qits-workspace-daemon/docs/openapi.yml`.
 *
 * One client for both because **a coding agent is a command**: `POST /agents` answers the same
 * `{command: …}` envelope `POST /commands` does, and the document says so explicitly so that one
 * decoder serves both. Splitting them would buy two decoders for one shape.
 *
 * These types are what the whole agent surface is built on — the Chat tab here, the run history and
 * the session tree later — so they are written from the contract rather than from what Chat happens
 * to read today.
 */

/** Whether a command is still going, and how it stopped if not. */
export type CommandStatus = 'RUNNING' | 'EXITED' | 'TERMINATED' | 'INTERRUPTED';

/**
 * What the frontend routes its view on.
 *
 * `TERMINAL` is an interactive PTY, `CHAT` is a coding-agent session over line-delimited JSON on
 * pipes, and `SERVICE` is carried because it is part of the shape — this surface does not launch
 * services, `/services` does.
 */
export type CommandKind = 'TERMINAL' | 'CHAT' | 'SERVICE';

/** Which harness ran, or is to run. */
export type AgentType = 'CLAUDE' | 'KIMI';

/**
 * Which MCP servers a launch is wired to.
 *
 * `ACTIONS` fails with an explanation today — no service in the split serves that server — so
 * `REPOSITORY` is the only value this client sends.
 */
export type AgentMcpScope = 'ACTIONS' | 'REPOSITORY';

/** `CHAT` is the stream-json conversation over pipes; `INTERACTIVE` is the full agent TUI on a PTY. */
export type AgentLaunchMode = 'CHAT' | 'INTERACTIVE';

/**
 * Where in the product a session was started from — **not** which MCP servers it is wired to.
 *
 * The two axes cross freely and neither substitutes for the other: {@link AgentMcpScope} is
 * *addressing*, how narrow the server urls are, and the surface is *what the session is for*. The
 * platform's vocabulary is eight keys wide and lives in the harness library; this application owns
 * exactly the two below, which is why only those two are spelled here. A key this app never sends is
 * not a key this app should be able to send by accident.
 *
 * **Sending it is the whole point, and it is why these two strings exist at all.** The workspace
 * detail route's chat and agents tabs post a request that is byte-identical to the refining route's
 * in qits-projects-frontend — same scope, same mode, same body — so the daemon serving both cannot
 * tell an epic's chat from an ad-hoc workspace's, and neither can anything downstream. Until both
 * frontends name their own surface, a configuration given to `epic.chat` is a configuration given to
 * every `workspace.chat` on the platform as well.
 */
export type AgentSurface = 'workspace.chat' | 'workspace.agent';

/** How a session entered a command's lineage. */
export type AgentSessionSource = 'PINNED' | 'RESUMED' | 'FORKED' | 'SWITCHED' | 'REPORTED';

/** One session a command drove. In `Command.agentSessions` the **last** entry is the current one. */
export interface AgentSessionRefDto {
  readonly sessionId: string;
  readonly source: AgentSessionSource;
  readonly forkedFromSessionId?: string;
  readonly transcriptPath?: string;
  readonly recordedAt: string;
}

/**
 * One run inside the container.
 *
 * `repoId`, `workspaceId` and `shortCommitHash` are synthesized by the daemon: they are on the
 * host's DTO but ambient inside the container, and the daemon reproduces them so the host's shape
 * reconstructs unchanged.
 *
 * The optional fields are optional for one reason each: `finishedAt` and `exitCode` are absent while
 * running, `actionId` is absent for a run with no declared action behind it, and the commit pair is
 * absent when the checkout's HEAD was unknown at launch.
 */
export interface CommandDto {
  readonly id: string;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly branch: string;
  readonly actionName: string;
  readonly actionId?: string;
  readonly status: CommandStatus;
  readonly interactive: boolean;
  readonly kind: CommandKind;
  readonly launchedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly commitHash?: string;
  readonly shortCommitHash?: string;

  /**
   * The surface the launch named, echoed back — `AgentSurface`'s key as a plain string.
   *
   * A string rather than {@link AgentSurface} on purpose: a command answered here may have been
   * launched by *another* surface entirely (the two composed runs are nobody's button), so a union
   * of the two keys this app sends would be a type that lies about what can arrive.
   *
   * **Absent for three different reasons**, none of them an error: a command that is not an agent,
   * the sign-in terminal, and every agent command launched before the daemon learned to report it.
   * Nothing on this page branches on it yet — it is declared because the field is on the wire and a
   * reader should not have to rediscover it — but it is what a later change reads instead of
   * matching a display name, which is the contract this epic exists to delete.
   */
  readonly agentSurface?: string;
  readonly agentSessions: readonly AgentSessionRefDto[];
}

/** The single-command envelope both `POST /commands` and `POST /agents` answer with. */
interface CommandEnvelope {
  readonly command: CommandDto;
}

/** The list envelope: newest first, each row keeping the `{command: …}` wrapper. */
interface CommandListResponse {
  readonly entries: readonly CommandEnvelope[];
}

/**
 * What a launch asks for.
 *
 * **`deliverTaskPrompt` is never set true by this client.** It seeds the session with an instruction
 * to fetch the prompt through an MCP tool called `taskPrompt`, and that tool is not implemented
 * anywhere on the platform — the agent would be told to call something that does not exist. The
 * composed prompt rides `initialContext` instead, which works today and covers everything except
 * images.
 */
export interface LaunchAgentRequest {
  readonly scope: AgentMcpScope;

  /**
   * Which surface asked, and **required rather than optional** so a later launch site cannot quietly
   * omit it.
   *
   * The daemon resolves a missing surface to the one this request's *shape* implies — a workspace
   * container's interactive launch reads as `workspace.agent`, its chat as `workspace.chat` — which
   * is a migration crutch with an expiry, not a contract: it exists so the daemons could ship before
   * the frontends, and the guess collapses `epic.chat` into `workspace.chat` precisely because the
   * two requests are indistinguishable. Naming it here is what makes the guess removable.
   */
  readonly surface: AgentSurface;
  readonly mode: AgentLaunchMode;
  readonly agentType?: AgentType;
  readonly initialContext?: string;
  readonly resumeSessionId?: string;
  readonly fork?: boolean;
  readonly deliverTaskPrompt?: boolean;
}

/** What `POST /prompt-refinements` answers. */
interface RefinementResponse {
  readonly prompt: string;
}

/**
 * One action the checkout's `.qits-config.yml` declares, and therefore one thing `POST /commands`
 * will accept.
 *
 * **There is no origin field, because there is only one origin.** The platform's globally defined
 * "code actions" did not survive the split — the action tools never left the monolith — so the old
 * `code` / `config` badge describes a distinction that no longer exists. Do not build it back.
 *
 * `interactive` says the run wants a PTY. It is a fact about the action, not a refusal: the launch
 * is spawn-and-return either way, and the flag is what a caller reads before deciding to open a
 * terminal socket for it.
 */
export interface ActionDto {
  readonly id: string;
  readonly name: string;
  readonly interactive: boolean;
}

interface ActionListResponse {
  readonly actions: readonly ActionDto[];
}

/** Which stream a captured line came from. `TRANSCRIPT` is an imported agent transcript. */
export type LogChannel = 'STDIN' | 'OUTPUT' | 'STDERR' | 'TRANSCRIPT';

/**
 * One captured line of a command's output.
 *
 * `sequence` is the monotonic per-command ordinal assigned at capture, and it is the stable sort key
 * — timestamps can tie. **`severity` is never set by this daemon**: the log service is wired with a
 * null classifier, because pattern- and severity-based error detection was deleted upstream and is
 * not coming back. It is absent from this type for that reason; a field nothing writes is not a
 * field a reader should branch on.
 */
export interface CommandLogLineDto {
  readonly sequence: number;
  readonly channel: LogChannel;
  readonly content: string;
  readonly timestamp: string;
}

interface CommandLogResponse {
  readonly lines: readonly CommandLogLineDto[];
}

@Injectable({ providedIn: 'root' })
export class CommandsApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * Every command this container has run, newest first.
   *
   * Unfiltered on purpose. One entry is shared by the Chat tab, the Actions history, the session
   * tree and the embedded session, and the discipline that makes that sharing work is identical key
   * *and* identical result shape — a `?status=RUNNING` read here would be a second, narrower cache
   * of the same thing, and the two would silently stop being one.
   *
   * The store is in-memory and per container: a recreate starts it empty and a stopped container has
   * none at all. There is no host-side fallback, so "the container is stopped" is a state to render,
   * not an empty list.
   */
  async commands(workspaceRowId: number): Promise<readonly CommandDto[]> {
    const answer = await this.daemon.get<CommandListResponse>(workspaceRowId, '/commands');
    return (answer.entries ?? []).map((entry) => entry.command);
  }

  /**
   * What this checkout declares, in config order.
   *
   * On this client rather than one of its own because the surface is the same one: an action is what
   * `POST /commands` accepts, the daemon files both under the same tag, and a separate client would
   * buy a second file that has to move whenever this contract does.
   */
  async actions(workspaceRowId: number): Promise<readonly ActionDto[]> {
    const answer = await this.daemon.get<ActionListResponse>(workspaceRowId, '/commands/actions');
    return answer.actions ?? [];
  }

  /**
   * Launch a declared action. Spawn-and-return, always.
   *
   * **There is no fire-and-await form on this API**, so no inline exit-code-and-stdout panel is
   * possible: the `RunCommand`/`CommandChunk`/`CommandExit` triple exists only on the control
   * socket, and the daemon's own comment says it wires no production caller. A config action
   * therefore reports through the run history and its log like any other command, which is the
   * whole of what this client can honestly offer.
   */
  async runAction(workspaceRowId: number, actionId: string): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(workspaceRowId, '/commands', {
      actionId,
    });
    return answer.command;
  }

  /**
   * One command's captured lines, in order.
   *
   * Read **on demand**, when a history row is expanded, and never on load: it is the one request on
   * the Actions tab that is proportional to what the user asks for rather than to what the tab
   * shows. The daemon caps capture at 50,000 lines per command — heap in a container sized for the
   * workspace's own build — so a very chatty command has lost its oldest lines before this is asked.
   */
  async log(workspaceRowId: number, commandId: string): Promise<readonly CommandLogLineDto[]> {
    const answer = await this.daemon.get<CommandLogResponse>(
      workspaceRowId,
      `/commands/${encodeURIComponent(commandId)}/log`,
    );
    return answer.lines ?? [];
  }

  /**
   * Signal a running command's process group, and answer it in its post-terminate state.
   *
   * Distinct from *closing a socket*, which only detaches and leaves the process running — the whole
   * reason a tab switch is free.
   */
  async terminate(workspaceRowId: number, commandId: string): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(
      workspaceRowId,
      `/commands/${encodeURIComponent(commandId)}/terminate`,
    );
    return answer.command;
  }

  /** Launch a coding agent. The answer is the command to attach a socket to. */
  async launchAgent(workspaceRowId: number, request: LaunchAgentRequest): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(workspaceRowId, '/agents', request);
    return answer.command;
  }

  /**
   * Open the harness's sign-in terminal: the one-time OAuth an operator completes so every container
   * on the shared credential volume is signed in.
   *
   * **A door, not a fallback, and a normal launch like any other.** It used to be what `POST /agents`
   * *became* when nobody was signed in — the session you asked for was silently swapped for this
   * REPL and the caller attached to it as though it were an agent. That substitution is gone from the
   * harness library, which refuses instead; what is left is this, reached deliberately, by a caller
   * that has told the user what it is opening.
   *
   * The answer is the same `{command: …}` envelope every other launch answers, and the command is an
   * ordinary interactive `TERMINAL` — so it is attached, rendered and exited exactly like a session,
   * with no special case anywhere but the sentence above it.
   */
  async launchSignIn(workspaceRowId: number, agentType?: AgentType): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(
      workspaceRowId,
      '/agents/sign-in',
      agentType ? { agentType } : {},
    );
    return answer.command;
  }

  /**
   * Rewrite a rough transcript into a task prompt: one model call over the harness already installed
   * in this container.
   *
   * The `preamble` is the workspace's stated goal and has **no source inside the container** — it is
   * host-side metadata — so the caller reads it off the workspace row and passes it here. A blank
   * transcript is a 400 rather than an empty answer.
   */
  async refinePrompt(
    workspaceRowId: number,
    transcript: string,
    preamble: string | null,
  ): Promise<string> {
    const body: Record<string, string> = { transcript };
    if (preamble) {
      body['preamble'] = preamble;
    }
    const answer = await this.daemon.post<RefinementResponse>(
      workspaceRowId,
      '/prompt-refinements',
      body,
    );
    return answer.prompt;
  }
}
