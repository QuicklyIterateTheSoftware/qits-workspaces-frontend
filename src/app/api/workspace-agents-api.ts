import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  AgentDeliveryDto,
  AgentDispatchDto,
  AgentDto,
  AgentState,
  AgentWaitDto,
  AgentsResponse,
  CreateAgentRequest,
} from './dto';

/** The filters `GET /workspaces/api/agents` takes. Each one is optional. */
export interface AgentFilter {
  readonly workId?: string;
  readonly workspaceId?: number;
  readonly state?: AgentState;
}

/**
 * The agent doors of qits-workspaces (epic qits-1152).
 *
 * An agent is one work item's coding agent and its worktree inside a workspace. The service owns
 * every start, yield and resume; this client reads agents, creates one for a work item, sends it a
 * turn, and discards it.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceAgentsApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /** Agents, newest first. */
  async agents(filter: AgentFilter = {}): Promise<readonly AgentDto[]> {
    let params = new HttpParams();
    if (filter.workId) {
      params = params.set('workId', filter.workId);
    }
    if (filter.workspaceId !== undefined) {
      params = params.set('workspaceId', filter.workspaceId);
    }
    if (filter.state) {
      params = params.set('state', filter.state);
    }
    const answer = await firstValueFrom(
      this.http.get<AgentsResponse>(`${this.base}/workspaces/api/agents`, { params }),
    );
    return answer.agents ?? [];
  }

  /** One agent, in any state. 404 when there is no such agent. */
  async agent(agentId: string): Promise<AgentDto> {
    return firstValueFrom(this.http.get<AgentDto>(this.url(agentId)));
  }

  /**
   * An agent for an existing work item. Answers the item's ACTIVE agent (`fresh: false`) when it
   * already has one, so a second press is not an error.
   */
  async create(request: CreateAgentRequest): Promise<AgentDispatchDto> {
    return firstValueFrom(
      this.http.post<AgentDispatchDto>(`${this.base}/workspaces/api/agents`, request),
    );
  }

  /**
   * Remove the agent: worktrees, credential and draft.
   *
   * Without `force` the service refuses with a 409 when the agent has uncommitted or unpushed work
   * (`AGENT_HAS_LEFTOVER_WORK`) or its daemon does not answer (`AGENT_DAEMON_UNREACHABLE`).
   */
  async discard(agentId: string, force = false): Promise<AgentDto> {
    return firstValueFrom(this.http.post<AgentDto>(`${this.url(agentId)}/discard`, { force }));
  }

  /**
   * Say something to the agent of a work item. A yielded agent resumes to hear it; a running one
   * hears it at its next turn boundary.
   */
  async deliver(workId: string, text: string): Promise<AgentDeliveryDto> {
    return firstValueFrom(
      this.http.post<AgentDeliveryDto>(`${this.base}/workspaces/api/agent-dispatches/delivery`, {
        workId,
        text,
        compactFirst: false,
      }),
    );
  }

  /**
   * The agent's open waits (qits-1153). A service without the door answers 404, which reads as
   * "no waits" here: the page shows waits when there are any and says nothing otherwise.
   */
  async openWaits(agentId: string): Promise<readonly AgentWaitDto[]> {
    try {
      const answer = await firstValueFrom(
        this.http.get<unknown>(`${this.url(agentId)}/waits`, {
          params: new HttpParams().set('state', 'OPEN'),
        }),
      );
      return waitsOf(answer).filter((wait) => wait.state === 'OPEN');
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 404 || status === 405) {
        return [];
      }
      throw error;
    }
  }

  private url(agentId: string): string {
    return `${this.base}/workspaces/api/agents/${encodeURIComponent(agentId)}`;
  }
}

/** The waits list, as a bare array or as `{waits: […]}`: the door is new and its envelope is not fixed. */
function waitsOf(answer: unknown): readonly AgentWaitDto[] {
  if (Array.isArray(answer)) {
    return answer as AgentWaitDto[];
  }
  const waits = (answer as { waits?: unknown } | null)?.waits;
  return Array.isArray(waits) ? (waits as AgentWaitDto[]) : [];
}
