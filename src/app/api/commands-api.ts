import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's command surface, hand-written from `qits-workspace-daemon/docs/openapi.yml`.
 *
 * Every agent's harness is a command, and a command id is unique across a workspace's agents, so the
 * list and the sockets need no agent in their path. The browser launches nothing here any more
 * (qits-1152): the service starts each agent's harness; this client reads commands, ends one, opens
 * the sign-in terminal and rewrites a prompt.
 */

/** Whether a command is still going, and how it stopped if not. */
export type CommandStatus = 'RUNNING' | 'EXITED' | 'TERMINATED' | 'INTERRUPTED';

/**
 * What the frontend routes its view on.
 *
 * `TERMINAL` is an interactive PTY, and `CHAT` is a coding-agent session over line-delimited JSON
 * on pipes.
 */
export type CommandKind = 'TERMINAL' | 'CHAT';

/** Which harness ran, or is to run. */
export type AgentType = 'CLAUDE' | 'KIMI';

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

/** The single-command envelope the command doors answer with. */
interface CommandEnvelope {
  readonly command: CommandDto;
}

/** The list envelope: newest first, each row keeping the `{command: …}` wrapper. */
interface CommandListResponse {
  readonly entries: readonly CommandEnvelope[];
}

/** One captured line of a command's log. Only the fields the transcript read needs. */
interface CommandLogLineDto {
  readonly sequence: number;
  readonly content: string;
}

interface CommandLogResponse {
  readonly lines?: readonly CommandLogLineDto[];
}

/** What `POST /prompt-refinements` answers. */
interface RefinementResponse {
  readonly prompt: string;
}

@Injectable({ providedIn: 'root' })
export class CommandsApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * Every command this container has run, newest first.
   *
   * Unfiltered on purpose: the Chat and Terminal tabs share one entry ({@link
   * ./workspace-commands#WorkspaceCommands}), and a narrower read would be a second cache of it.
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
   * A command's agent transcript so far: the harness's own JSONL lines, in order.
   *
   * For an agent in a terminal this is the conversation: the daemon tails the transcript while the
   * run is live (qits-1152), and the PTY stream is only the screen. The lines are what
   * `buildConversation` reads, the same shape a chat replays.
   */
  async transcript(workspaceRowId: number, commandId: string): Promise<readonly string[]> {
    const answer = await this.daemon.get<CommandLogResponse>(
      workspaceRowId,
      `/commands/${encodeURIComponent(commandId)}/log`,
      { channel: 'TRANSCRIPT' },
    );
    return [...(answer.lines ?? [])]
      .sort((a, b) => a.sequence - b.sequence)
      .map((line) => line.content);
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
   * The `preamble` is what the work is about (the agent's work item); it has no source inside the
   * container, so the caller passes it. A blank transcript is a 400 rather than an empty answer.
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
