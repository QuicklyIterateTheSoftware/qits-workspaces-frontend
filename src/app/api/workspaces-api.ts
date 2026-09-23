import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ActiveProcessResponse,
  BootstrapRunDto,
  BootstrapRunsResponse,
  ContainerProcessResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DiscardResponse,
  EditorSessionDto,
  IntegrateResponse,
  MergeRequest,
  ServiceEventDto,
  ServiceEventsResponse,
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
 * One page of the service-event feed, which is what the panel shows.
 *
 * Twenty rather than the service's default fifty, because the feed is a recent-history strip under a
 * list and not a log viewer. It is also the number the client-side row-id filter is applied *to* —
 * see {@link WorkspacesApi.serviceEvents} — so a page that contains a recycled label's events shows
 * fewer than twenty rows, and the feed says so rather than quietly looking short.
 */
export const SERVICE_EVENT_PAGE_SIZE = 20;

/**
 * The calls this app makes against qits-workspaces: read a repository's workspaces, read one
 * workspace's running process and its history record, drive a container, open a project's editor,
 * and send work home.
 *
 * **There is one door home here and it is the integrate**, which is a narrowing of this client
 * rather than a simplification of it. qits-workspaces used to own a release door too — it stamped a
 * version onto the repository's default branch — and that door is gone: the default branch is
 * written by a release request in qits-projects, which folds the request's sources, releases a tag
 * and merges the default branch once the deployment is live. So there is no release call to make
 * from a workspace, and this client makes none.
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
   * Create a workspace, and — as the overview always does — over a branch that already exists.
   *
   * `repositoryId` is in the body and not in the query string, which is the one thing about this
   * route worth remembering: the listing above scopes by a query parameter, the create does not.
   * The service reads the field from the payload and answers 400 without it.
   *
   * Rejects with the `HttpErrorResponse`. A 409 here means the branch already has an active
   * workspace, which is the race a second press produces — so the caller re-reads the list rather
   * than retrying.
   */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const response = await firstValueFrom(
      this.http.post<CreateWorkspaceResponse>(`${this.base}/workspaces/api/workspaces`, request),
    );
    return response.workspace;
  }

  /**
   * Integrate one workspace: merge its branch into its **parent** branch and push. No version is
   * stamped and nothing is released — a task workspace lands on its epic, and the epic is what is
   * released later.
   *
   * The target is not sent: the parent is the service's own fact about the workspace. A workspace
   * whose parent *is* the default branch is refused with a 409 carrying `RELEASE_REQUIRED` — the
   * service guarding a branch it does not write at all, and naming the release request in
   * qits-projects that does. There is no door here to hand such a workspace on to, which is why
   * that surface is a sentence now rather than a second button.
   *
   * Rejects with the `HttpErrorResponse`, which is what {@link
   * ../merge/merge-outcome#classifyMergeFailure} reads to tell the guards' answers apart.
   */
  async integrate(workspaceId: number, summary: string): Promise<IntegrateResponse> {
    const body: MergeRequest = { summary };
    return firstValueFrom(
      this.http.post<IntegrateResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/integrate`,
        body,
      ),
    );
  }

  /**
   * One workspace, by the id every route addresses.
   *
   * **Nothing on the detail shell calls this yet, and that is the point.** The shell needs the
   * repository-scoped list regardless — it is the single cache entry that feeds the header, the
   * status strip and the activity bar at once — so reading one workspace on top of it would be a
   * second request for data already in hand. The method exists because the endpoint is landing
   * beside this work and the panels that mount later (a resolved workspace's read, a deep link that
   * arrives without a repository) are its callers.
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
   * Find or start the platform's editor, and say whether it answers yet.
   *
   * **One door for both**, because the request is the same sentence either way: "there should be an
   * editor here". A fresh one answers `201` and an existing one `200`, with the same body — so the
   * caller polls this and nothing else, and a reader who reloads mid-start rejoins the editor that
   * is already coming up instead of asking for a second one.
   *
   * **The door is unscoped, and that is the whole change from the generation before it.** There is
   * one shared editor for the platform rather than one per project: every project's wrapper is
   * cloned side by side in the single container behind it, so there is nothing for a caller to name
   * — no `repositoryId`, no project, and an empty body. Which project a reader lands in is decided
   * after the hand-off, by a `?folder=` on the editor's own address, and never by this request.
   */
  async ensureEditor(): Promise<EditorSessionDto> {
    return firstValueFrom(
      this.http.post<EditorSessionDto>(`${this.base}/workspaces/api/editor/ensure`, {}),
    );
  }

  /**
   * Stop the container. The branch is untouched: the container is a cache of it.
   *
   * The id is the row id every one of these routes addresses. It is accepted as a string too
   * because the editor door answers one — same address, spelled the way JSON spells an identifier.
   */
  async stopContainer(workspaceId: number | string): Promise<WorkspaceDto> {
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
  async recreateContainer(workspaceId: number | string): Promise<ContainerProcessResponse> {
    return firstValueFrom(
      this.http.post<ContainerProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/recreate-container`,
        {},
      ),
    );
  }

  /**
   * Abandon the work: the workspace resolves, unmerged, with an optional markdown note saying why.
   *
   * The note is the whole record of what was tried, so it is worth asking for — after this call the
   * workspace leaves the active list and only the history record remains.
   *
   * **`ignoreChanges` is the confirmed override of the clean-working-tree guard**, sent as
   * `?ignore-changes=true` on the URL — deliberately never part of the body, so the ordinary call
   * cannot carry it by accident. The first press always goes without it; only after the service has
   * refused with "uncommitted changes" and the person has confirmed that exact loss does a second
   * call spell it out.
   */
  async discard(
    workspaceId: number,
    result: string,
    ignoreChanges = false,
  ): Promise<DiscardResponse> {
    const suffix = ignoreChanges ? '?ignore-changes=true' : '';
    return firstValueFrom(
      this.http.post<DiscardResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/discard${suffix}`,
        { result },
      ),
    );
  }

  /**
   * One page of the durable service-event feed, newest first.
   *
   * **The server filters by the workspace *label*, and that is the trap this method exists to name.**
   * `service_event.workspace_id` is the branch-derived string — unique only among ACTIVE workspaces
   * and **reusable the moment one resolves** — so a workspace that inherits a retired name is served
   * its predecessor's events by a filter that is behaving exactly as documented. There is no row-id
   * parameter to ask for instead.
   *
   * So the narrowing happens twice: `repoId` and `workspaceId` go to the server because they cut the
   * page down to something worth transferring, and the caller then keeps only the rows whose
   * `workspaceRowId` is this workspace's. The DTO carries the row id for precisely this reason. That
   * second filter is the caller's rather than this method's, because dropping rows silently inside a
   * transport would hide the very ambiguity the panel has to report.
   */
  async serviceEvents(
    repositoryId: string,
    workspaceLabel: string,
  ): Promise<readonly ServiceEventDto[]> {
    const params = new HttpParams()
      .set('repoId', repositoryId)
      .set('workspaceId', workspaceLabel)
      .set('pageSize', SERVICE_EVENT_PAGE_SIZE);
    const response = await firstValueFrom(
      this.http.get<ServiceEventsResponse>(`${this.base}/workspaces/api/service-events`, {
        params,
      }),
    );
    return response.events ?? [];
  }

  /**
   * When each of this workspace's bootstrap steps last ran, and how it went.
   *
   * **Host-owned state, and not a forwarder.** The run *verbs* are the daemon's; this reads a host
   * table that has to outlive the container, and it is the only place that table is readable from.
   * The declared chain — what the steps *are* — comes from the daemon's own `GET /bootstrap-commands`
   * and the two are joined on `bootstrapCommandId`.
   *
   * Empty rather than 404 when the chain has never run here: a freshly created workspace has no rows
   * yet, and that is a state to render.
   */
  async bootstrapRuns(workspaceId: number): Promise<readonly BootstrapRunDto[]> {
    const response = await firstValueFrom(
      this.http.get<BootstrapRunsResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/bootstrap-runs`,
      ),
    );
    return response.runs ?? [];
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
   * right reader while the workspace is *live* — that is what the Agents tab uses — and it stops
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
