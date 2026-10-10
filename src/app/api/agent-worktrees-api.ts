import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/** One repository of an agent's worktree that is on a branch. `path` is empty for the wrapper. */
export interface AgentWorktreeBranchDto {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  /** The git host's branch is at `head`. */
  readonly pushed: boolean;
}

/**
 * One agent's worktree, as the workspace daemon reports it (`GET /agent-worktrees/{agentId}`).
 *
 * `commandId` is the harness's last command while the daemon knows it — the id the chat and terminal
 * sockets attach to. After a container restart it is null until the service starts the agent again.
 */
export interface AgentWorktreeDto {
  readonly agentId: string;
  readonly workId?: string | null;
  readonly wrapperBranch?: string | null;
  readonly path: string;
  readonly harnessRunning: boolean;
  readonly commandId?: string | null;
  readonly sessionId?: string | null;
  readonly branches: readonly AgentWorktreeBranchDto[];
  readonly dirty: boolean;
  readonly unpushed: boolean;
}

/**
 * The agent worktrees a workspace's daemon hosts, read through the container proxy.
 *
 * Read only. Starting, yielding and removing an agent are the service's (its scheduler holds the
 * agent's credential); the browser never calls those daemon doors.
 */
@Injectable({ providedIn: 'root' })
export class AgentWorktreesApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /** One agent's worktree. 404 when the daemon has no worktree for it. */
  async worktree(workspaceRowId: number, agentId: string): Promise<AgentWorktreeDto> {
    return this.daemon.get<AgentWorktreeDto>(
      workspaceRowId,
      `/agent-worktrees/${encodeURIComponent(agentId)}`,
    );
  }
}
