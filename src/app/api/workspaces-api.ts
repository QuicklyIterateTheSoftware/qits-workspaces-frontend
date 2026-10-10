import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ActiveProcessResponse,
  ContainerProcessResponse,
  WorkspaceAgentSessionDto,
  WorkspaceAgentSessionsResponse,
  WorkspaceAgentTranscriptResponse,
  WorkspaceDto,
  WorkspaceEntriesResponse,
  WorkspaceHistoryDetailDto,
  WorkspaceHistoryDetailResponse,
  WorkspaceResponse,
} from './dto';

/**
 * The workspace calls this app makes against qits-workspaces: read a repository's workspaces (the
 * slots agents run in), read one workspace's running process and its history record, and drive a
 * container. Agents have their own client, {@link ./workspace-agents-api#WorkspaceAgentsApi}.
 *
 * Nothing here creates a workspace or sends work home: the service makes a slot when an agent needs
 * one and removes it when its last agent is gone (qits-1152), and work goes home through a release
 * request in qits-projects.
 *
 * `HttpClient` on the fetch backend rather than bare `fetch()`, for two reasons that both cash out
 * elsewhere: `HttpTestingController` is the only request-mocking story Angular ships, and every
 * state this page draws is "given this response, render that"; and `withFetch()` routes through
 * `window.fetch`, which is what the platform's OTel browser instrumentation hooks. The observable
 * is unwrapped with `firstValueFrom` immediately — these are one-shot calls, and a promise is what
 * the page's `async` methods want.
 */
@Injectable({ providedIn: 'root' })
export class WorkspacesApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /**
   * One repository's live workspaces.
   *
   * `repositoryId` is a **required** filter and is sent as a query parameter rather than a path
   * segment on purpose: qits-workspaces does not own repositories — it holds the id as a string,
   * with no foreign key and no join, in a different database — so a workspace is not a sub-resource
   * of one. The repository is scope on the collection, which is what it actually is.
   *
   * The service answers only ACTIVE workspaces here; resolved ones live in its history view.
   */
  async workspaces(repositoryId: string): Promise<readonly WorkspaceDto[]> {
    const params = new HttpParams().set('repositoryId', repositoryId);
    const response = await firstValueFrom(
      this.http.get<WorkspaceEntriesResponse>(`${this.base}/workspaces/api/workspaces`, { params }),
    );
    return response.entries.map((entry) => entry.workspace);
  }

  /**
   * One ACTIVE workspace, by its row id. A 404 means it has resolved (or never existed), and
   * {@link history} is what is left to read.
   */
  async workspace(workspaceId: number): Promise<WorkspaceDto> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}`,
      ),
    );
    return response.workspace;
  }

  /**
   * The technical process running against this workspace, or null.
   *
   * This is the Starting tab's discovery lookup and one of the shell's two workspace reads on load.
   * It is asked again whenever the `process` hint fires, which is how a container start begun from
   * another screen still opens the tab here.
   */
  async activeProcess(workspaceId: number): Promise<string | null> {
    const response = await firstValueFrom(
      this.http.get<ActiveProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/active-process`,
      ),
    );
    return response.technicalProcessId;
  }

  /** Start the container if it is not up. Answers the process that is doing it. */
  async ensureContainer(workspaceId: number): Promise<ContainerProcessResponse> {
    return firstValueFrom(
      this.http.post<ContainerProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/ensure-container`,
        {},
      ),
    );
  }

  /**
   * Stop the container. Its agents' worktrees stay on the volume.
   */
  async stopContainer(workspaceId: number): Promise<WorkspaceDto> {
    return firstValueFrom(
      this.http.post<WorkspaceDto>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/stop-container`,
        {},
      ),
    );
  }

  /**
   * Throw the container away and build a fresh one.
   *
   * **The service refuses this with a 400 unless the working tree is provably clean**, because a
   * recreate discards whatever is only in the container. A client that offers the press anyway
   * turns a guard into an error message, so the button that calls this is disabled with the reason
   * whenever `clean` is not exactly `true` — and "unknown", which is what a disconnected daemon
   * reports, counts as not clean.
   */
  async recreateContainer(workspaceId: number): Promise<ContainerProcessResponse> {
    return firstValueFrom(
      this.http.post<ContainerProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/recreate-container`,
        {},
      ),
    );
  }

  /**
   * A workspace's history record — the narrative, for a workspace that has already resolved.
   *
   * The detail view reads this in exactly one situation: the id is not in its repository's active
   * list. That means the work is finished (or the id is wrong), and the record is what there is to
   * show. It carries no branch state, no runtime and no commands, which is precisely why a resolved
   * workspace does not get a detail view.
   */
  async history(workspaceId: number): Promise<WorkspaceHistoryDetailDto> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceHistoryDetailResponse>(
        `${this.base}/workspaces/api/history/${encodeURIComponent(workspaceId)}`,
      ),
    );
    return response.workspace;
  }

  /**
   * The coding-agent sessions that ran in a workspace, for a workspace that has already resolved.
   *
   * **Host-owned, and it must not go through `WorkspaceDaemonApi`.** That client is the
   * container proxy, and a resolved workspace has no container: every call through it answers 404,
   * which is exactly the bug this endpoint exists to fix. The daemon's own session surface is the
   * right reader while the workspace is *live*, and it stops
   * existing the moment the container is destroyed. The host keeps the record, so the host is who
   * this asks, on the plain `HttpClient` against `/workspaces/api/history/...` like
   * {@link WorkspacesApi.history} beside it.
   *
   * Empty rather than 404 when no agent ever ran here: a workspace somebody drove by hand has no
   * sessions, and that is a state to render.
   */
  async agentSessions(workspaceId: number): Promise<readonly WorkspaceAgentSessionDto[]> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceAgentSessionsResponse>(
        `${this.base}/workspaces/api/history/${encodeURIComponent(workspaceId)}/agent-sessions`,
      ),
    );
    return response.sessions ?? [];
  }

  /**
   * One of those sessions' conversation, as raw transcript lines.
   *
   * Host-owned for the same reason as {@link WorkspacesApi.agentSessions}: the proxy answers 404 for
   * a workspace whose container is gone, so the record is read from the service that kept it.
   *
   * The lines are handed on untouched. They are the shape the live chat socket carries, so the
   * caller feeds them to the same `buildConversation` and draws them with the same
   * `<app-conversation>` — the record and the live view cannot disagree about a conversation when
   * neither one owns the rendering of it.
   */
  async agentTranscript(workspaceId: number, sessionId: string): Promise<readonly string[]> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceAgentTranscriptResponse>(
        `${this.base}/workspaces/api/history/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(sessionId)}/transcript`,
      ),
    );
    return response.lines ?? [];
  }
}
