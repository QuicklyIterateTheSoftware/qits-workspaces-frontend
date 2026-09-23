/**
 * The wire shapes this client reads and writes, hand-written and copied field-for-field from the
 * Java records on the other side (`WorkspaceDto` and `WorkspaceController`'s nested request records
 * in qits-workspaces; `ProjectDto` and `RepositoryDto` in qits-projects).
 *
 * Hand-written rather than generated, deliberately (the explorer plan's Decision 1). The platform
 * generates OpenAPI *documents*, not clients, and every controller nests its request and response
 * records inside the request type, so a generator names them positionally — qits-projects'
 * committed document already calls the list-projects response `Response19` and one entry `Entry4`.
 *
 * The envelopes are genuinely inconsistent across the two services — `{entries: [{workspace: …}]}`
 * for the workspace list, `{entries: [{project: …}]}` and `{entries: [{repository: …}]}` for
 * projects — and the interfaces say so rather than pretending otherwise.
 *
 * `Instant` arrives as an ISO-8601 string; every timestamp below is typed as one.
 */

/** A workspace's resolution state. `ACTIVE` is the only one an integrate can be offered on. */
export type WorkspaceStatus = 'ACTIVE' | 'INTEGRATED' | 'ABANDONED';

/**
 * The container's runtime state, independent of {@link WorkspaceStatus}: the branch is the source
 * of truth and the container is a recreatable cache of it.
 *
 * It is shown here and never gated on. **Both merges read the durable branch, not the container** —
 * qits-workspaces merges from the bare origin's refs — so a STOPPED workspace releases and
 * integrates exactly as well as a RUNNING one, and disabling the button on one would be a fiction.
 */
export type WorkspaceRuntimeStatus = 'RUNNING' | 'STOPPED' | 'PROVISIONING' | 'FAILED';

/**
 * The coding-agent activity rollup, as last reported by the in-container `workspace-daemon`.
 *
 * **`ENDED` arrives, and then ages out.** The registry used to evict a workspace's entry the moment
 * a session ended, which made `ENDED` unreachable; it now keeps the entry and expires it after
 * thirty minutes (`qits.workspace.agent-activity.ended-ttl-ms`). So the rollup answers `ENDED` for
 * half an hour after a session stops and null after that. That window is what the activity bar's
 * ordering rule needs — a session that has just stopped bubbles to the far left, since that is the
 * workspace wanting your next prompt — and it survives a page reload. A live report always wins: a
 * resume overwrites the `ENDED` entry.
 */
export type AgentActivityState = 'IDLE' | 'BUSY' | 'WAITING' | 'ENDED';

/**
 * One workspace, as qits-workspaces lists it.
 *
 * `id` is the identifier every route addresses — including the two merge ones. `workspaceId` is the
 * branch-derived *label*: unique only per repository and reusable once the workspace resolves, so
 * it is displayed and never used to address anything.
 *
 * `parent` is the branch this work goes home to, and it is what picks the door: a workspace whose
 * parent is the repository's default branch is **released**, any other workspace is **integrated**
 * into that parent. So this field is not decoration on the row — it decides which action the row
 * offers.
 */
export interface WorkspaceDto {
  readonly id: number;
  readonly workspaceId: string;
  readonly parent: string | null;
  readonly branch: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly conflictsWithParent: boolean;
  readonly status: WorkspaceStatus;
  readonly runtimeStatus: WorkspaceRuntimeStatus | null;
  readonly runtimeError: string | null;
  readonly clean: boolean | null;
  readonly agentActivity: AgentActivityState | null;
  readonly preamble: string | null;

  /**
   * What a **dispatched** workspace is for: the qits-projects ticket or epic the dispatch was about,
   * by id. Both `null` for a workspace a person created by hand — which states its scope in its
   * `preamble` instead — and for every workspace created before the fields existed.
   *
   * **Optional**, for the reason `admin` and `createdAt` are: a deployed qits-workspaces that
   * predates them answers neither, and `undefined` says exactly that rather than claiming the
   * workspace was hand-made.
   *
   * Neither id is resolved anywhere — there is no cross-application read — so what turns one into a
   * link is `ui/workspace-subject`, which takes the *slug* off the workspace's own branch and
   * composes the address through `QitsAppLinks`.
   */
  readonly ticketId?: string | null;
  readonly epicId?: string | null;

  readonly result: string | null;
  readonly resolvedAt: string | null;
  readonly daemonConnectedAt: string | null;
  readonly daemonVersion: string | null;
  readonly daemonBuildTime: string | null;
  readonly daemonOutdated: boolean | null;

  /**
   * When the workspace row was created — the overview's ordering key, and **optional on purpose**.
   *
   * The field is landing on qits-workspaces beside this change, so a deployed service may or may not
   * answer it. Optional rather than nullable says exactly that: `undefined` means "this service does
   * not send it yet", and the tree sorts those rows last instead of pretending they are old.
   */
  readonly createdAt?: string;

  /**
   * Whether this workspace runs in **admin mode** — its container holds the host's docker socket,
   * which makes it root-equivalent on the host.
   *
   * Decided in the request that created the workspace and never afterwards, so it is a fact about
   * the workspace rather than about its current container. **Optional**, for the reason `createdAt`
   * is: a service that predates the posture answers nothing here, and `undefined` says that rather
   * than claiming the workspace is ordinary. Read it as privileged only when it is literally `true`.
   */
  readonly admin?: boolean;
}

/** The workspace list envelope: entries, each wrapping the thing it lists. */
export interface WorkspaceEntriesResponse {
  readonly entries: readonly { readonly workspace: WorkspaceDto }[];
}

/**
 * What the single-workspace read answers.
 *
 * **This endpoint is not deployed yet** — `GET /workspaces/api/workspaces/{id}` answers 404 on the
 * platform as this is written, and lands with the host workstream running beside this one. The
 * shape is frozen in the plan, so the client is written to it and asserted against a mock; nothing
 * on the detail shell depends on it, because the shell reads the repository-scoped list it needs
 * for the activity bar anyway and finds itself in it.
 */
export interface WorkspaceResponse {
  readonly workspace: WorkspaceDto;
}

/**
 * The workspace's currently-running technical process, or null when nothing is running.
 *
 * This is the Starting tab's discovery lookup: an id here means "open the payload-bearing stream at
 * `/technical-processes/{id}/events`", and null means the transient tab is simply not present.
 */
export interface ActiveProcessResponse {
  readonly technicalProcessId: string | null;
}

/**
 * What `ensure-container` and `recreate-container` answer: the workspace as it now stands, plus the
 * process that is doing the work.
 *
 * The two verbs differ in what they do and not in what they return, which is why one type covers
 * both. The process id is what the Starting tab attaches to without waiting for the `process` hint
 * to come round.
 */
export interface ContainerProcessResponse {
  readonly workspace: WorkspaceDto;
  readonly technicalProcessId: string | null;
}

/**
 * The in-container editor's own state, as the daemon reports it, and it is **not** the container's.
 *
 * A container can be `RUNNING` with no editor in it yet — `STARTING` is the whole reason this page
 * has a waiting state — and `ENDED` is an editor that ran and stopped inside a container that is
 * still up. `null` is a container the daemon has not answered for at all, which reads as "not yet"
 * rather than as an ending.
 */
export type EditorState = 'STARTING' | 'RUNNING' | 'ENDED';

/**
 * What `POST /workspaces/api/editor/ensure` answers: the workspace carrying the platform's one
 * shared editor, what its container is doing, and the one field a caller acts on.
 *
 * The door names no project — there is a single editor for the whole platform, holding every
 * project's wrapper side by side — so this body is the same body for every caller, and a request
 * that carried a scope would be answering a question nobody asks any more.
 *
 * **`editorReady` is the readiness, and the two states are not it.** A caller that waited for
 * `editorState === 'RUNNING'` would be deciding for itself when the editor answers requests; the
 * service owns that judgement — it holds the container status *and* the daemon's report — and says
 * so in one boolean. The states are what the page *shows* while the boolean is false, and `ENDED`
 * is the one that stops the waiting rather than continuing it.
 *
 * The call is idempotent: a second one against a live editor answers `200` with the same body a
 * `201` carried, which is what makes polling it the whole readiness protocol.
 */
export interface EditorSessionDto {
  readonly workspaceId: string;
  readonly containerStatus: string;
  readonly editorState: EditorState | null;
  readonly editorReady: boolean;
}

/** What `discard` answers. One boolean, and the workspace is resolved by the time it arrives. */
export interface DiscardResponse {
  readonly success: boolean;
}

/** One entry in a resolved workspace's narrative: what happened to the branch, and when. */
export interface WorkspaceHistoryEventDto {
  readonly type: string;
  readonly branch: string | null;
  readonly parent: string | null;
  readonly target: string | null;
  readonly commit: string | null;
  readonly note: string | null;
  readonly at: string;
}

/**
 * A resolved workspace, as the history surface serves it.
 *
 * It is the narrative record and **not** a detail view's data: there is no branch state, no runtime
 * status, no clean flag and no daemon.
 *
 * It used to carry a `commands` field that was always empty, because the host's command-history port
 * had no implementation anywhere; the port and the field are both gone now. What a reader actually
 * wants from a finished workspace is the *conversations* that changed it, and those come from
 * {@link WorkspaceAgentSessionDto} on a surface of their own rather than from this record.
 */
export interface WorkspaceHistoryDetailDto {
  readonly id: number;
  readonly workspaceId: string;
  readonly parent: string | null;
  readonly status: WorkspaceStatus;
  readonly preamble: string | null;
  readonly result: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly events: readonly WorkspaceHistoryEventDto[];
}

/** The history read's envelope. */
export interface WorkspaceHistoryDetailResponse {
  readonly workspace: WorkspaceHistoryDetailDto;
}

/**
 * One side-chain a finished session's `Task` calls spawned, as the *host* records it.
 *
 * Field-for-field the daemon's own `AgentSubagentDto` minus the live-only parts: by the time the
 * host holds a session there is nothing left to sweep, so `messageCount` is a settled number here
 * rather than the daemon's "omitted means not swept yet".
 *
 * `agentType` and `description` stay agent-produced free text and either may be missing — an agent
 * that spawned a `Task` without describing it is a normal thing, not a broken record — so they are
 * nullable and are drawn as the words the agent chose, never matched against a vocabulary.
 *
 * This is a *summary* and not a place to read from: a subagent's own lines arrive inside the
 * session's transcript, behind the `qits_agent_meta` anchor, and are drawn there.
 */
export interface WorkspaceAgentSubagentDto {
  readonly agentId: string;
  readonly agentType: string | null;
  readonly description: string | null;
  readonly messageCount: number;
}

/**
 * One coding-agent session that ran in a workspace, as the host kept it after the container went.
 *
 * **A workspace normally has several.** Refine, implement and verify are separate dispatches into
 * the same workspace, and each is its own session — so this is a list a reader picks from, and the
 * fields here exist to make that pick possible: when it ran, how long it went on for, how much was
 * said, and which sub-agents it spun up.
 *
 * `endedAt` is nullable although a settled session always has one: a session whose container was
 * destroyed mid-run never wrote an ending, and drawing an em dash for it is honest where inventing a
 * close time would not be.
 */
export interface WorkspaceAgentSessionDto {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly messageCount: number;
  readonly subagents: readonly WorkspaceAgentSubagentDto[];
}

/**
 * The session-list envelope.
 *
 * **An empty `sessions` is a normal answer and not an error**, and it is the common one for now: the
 * volume the host reads transcripts from is not mounted on the service yet, so a workspace that ran
 * several sessions still answers with none until an operator applies it.
 *
 * That makes the empty case ambiguous by construction — it means "none could be read", never "none
 * ran" — and a caller must not draw it as the second. Nothing on the wire distinguishes the two, so
 * the honest rendering is the weaker claim.
 */
export interface WorkspaceAgentSessionsResponse {
  readonly sessions: readonly WorkspaceAgentSessionDto[];
}

/**
 * One session's conversation, as raw transcript lines.
 *
 * **Deliberately the same line shape the live chat socket carries** — one JSON object per line, the
 * harness's own `stream-json` events plus the three synthetic lines qits adds — so the record and
 * the live view are rendered by the same parser and the same component, and cannot drift into
 * showing the same conversation two different ways. Nothing here interprets a line; they go straight
 * into `buildConversation`.
 */
export interface WorkspaceAgentTranscriptResponse {
  readonly lines: readonly string[];
}

/**
 * One frame of a technical process's replayable stream, copied field-for-field from
 * `TechnicalProcessFrame`.
 *
 * Every field but `kind` and `seq` is nullable because one record carries five frame shapes.
 * `segment` is null on `done` and `ping`; `line` is set only on `line`; `status` only on
 * `segment-settled` and `done`; `hint`/`hintTarget` only on a *failed* settle.
 *
 * `seq` is per-subscription and a reconnect replays everything with fresh ordinals — so it orders
 * one connection's frames and is never a resume token. The client rebuilds from scratch on every
 * connect, which is the intended contract rather than a fallback.
 */
export interface TechnicalProcessFrame {
  readonly segment: string | null;
  readonly kind: 'segment-open' | 'line' | 'segment-settled' | 'done' | 'ping';
  readonly seq: number;
  readonly line: string | null;
  readonly status: 'ok' | 'failed' | null;
  readonly hint: string | null;
  readonly hintTarget: string | null;
}

/**
 * The one documented failure classification: the verb hit a remote's auth wall.
 *
 * `hintTarget` names the repository to sign into, and **for a submodule child that is not the root
 * repository** — so a UI acting on it must use the target it is given rather than the workspace's
 * own repository.
 */
export const HINT_REMOTE_AUTH = 'remote-auth';

/**
 * What `POST …/{id}/integrate` takes. One field, and no target.
 *
 * **The target is not a parameter: it is derived from the workspace.** An integrate always lands on
 * the workspace's parent branch, which is a fact the service already holds — so a client that could
 * name a target would be describing an API that does not exist.
 *
 * The summary becomes the merge commit's subject, as `integrate(<branch>): <summary>`. It is capped
 * at 100 characters on both sides: the conventional 72-character subject budget minus roughly the 24
 * a scope costs, rounded to a number a person can be told.
 */
export interface MergeRequest {
  readonly summary: string;
}

/** The summary cap, server-side `@Size(max = 100)` and the input's `maxlength` alike. */
export const SUMMARY_MAX_LENGTH = 100;

/**
 * What a successful integrate answers. **No version** — an integrate stamps none, because it is a
 * merge and not a release.
 *
 * `targetBranch` is the parent the work landed on. It is answered rather than assumed: the client
 * picked this door from the workspace's `parent`, and the service is the one that decides where an
 * integrate goes.
 */
export interface IntegrateResponse {
  readonly commitSha: string;
  readonly branch: string;
  readonly targetBranch: string;
}

/** How loud a service event is. Set on the event, never derived from its text. */
export type ServiceEventSeverity = 'INFO' | 'WARNING' | 'ERROR';

/**
 * What a service event reports.
 *
 * `STATUS_CHANGED` is the only member, and the enum has only ever had one: the classified-error kind
 * belonged to the per-line log observers that were deleted upstream. It is a type rather than a
 * constant because the wire carries the name, and a client that pinned the string would be claiming
 * a newer service cannot invent a second one.
 */
export type ServiceEventKind = 'STATUS_CHANGED';

/** The supervisor state a `STATUS_CHANGED` event is reporting. */
export type ServiceEventStatus = 'STARTING' | 'READY' | 'RESTARTING' | 'CRASHED' | 'STOPPED';

/**
 * One durable thing that happened to a service.
 *
 * **This is the only place a browser can see a `CRASHED`.** The live list flattens every terminal
 * state to `STOPPED` — a service that dies leaves the supervisor's map — so the transition survives
 * here and nowhere else a client can reach. That is what makes the feed a section of the Services
 * panel rather than a nicety beside it.
 *
 * **`workspaceId` is the branch-derived label and `workspaceRowId` is the identity**, and the gap
 * between them is a real trap: the feed's server-side filter takes the *label*, which is unique only
 * among ACTIVE workspaces and is **reused once a workspace resolves**. Filtering by it alone
 * therefore surfaces a previous workspace's events on a recycled name. The row id is carried for
 * exactly this reason and the client filters on it — see `service-events-feed.ts`.
 *
 * The anchor fields (`source`, `anchorFrom`, `anchorTo`, `sourceEpoch`) are null on plain status
 * transitions, which is every event this platform still produces.
 */
export interface ServiceEventDto {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly workspaceRowId: number | null;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly kind: ServiceEventKind;
  readonly severity: ServiceEventSeverity;
  readonly status: ServiceEventStatus | null;
  readonly summary: string | null;
  readonly logExcerpt: string | null;
  readonly commandId: string | null;
  readonly source: string | null;
  readonly anchorFrom: number | null;
  readonly anchorTo: number | null;
  readonly sourceEpoch: string | null;
  readonly timestamp: string;
}

/** The service-event feed envelope. */
export interface ServiceEventsResponse {
  readonly events: readonly ServiceEventDto[];
}

/** How a bootstrap step's most recent run ended. */
export type BootstrapOutcome = 'SKIPPED' | 'SUCCEEDED' | 'FAILED';

/**
 * The most recent run of one bootstrap step in one workspace.
 *
 * **One row per (workspace, step), overwritten on each run** — a last-run view and never a log. That
 * is why the section below the chain says "last run" and offers no history: there is none to offer.
 *
 * `bootstrapCommandId` is the join key against the daemon's declared chain, which is why the id is
 * on the row rather than only the display name. `commandId` is null for a `SKIPPED` step, which
 * spawns no command and therefore has no output.
 */
export interface BootstrapRunDto {
  readonly bootstrapCommandId: string;
  readonly commandName: string;
  readonly outcome: BootstrapOutcome;
  readonly commandId: string | null;
  readonly exitCode: number | null;
  readonly ranAt: string;
}

/** The bootstrap-run envelope. */
export interface BootstrapRunsResponse {
  readonly runs: readonly BootstrapRunDto[];
}

/** A project's dns record, or the whole object is null when it registers no domain. */
export interface ProjectDnsRecordDto {
  readonly domain: string;
  readonly type: string;
  readonly value: string;
}

/** A project. The spine of the repository picker and nothing more here. */
export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly dns: ProjectDnsRecordDto | null;
}

/** projects' list envelope: entries, each wrapping the thing it lists. */
export interface ProjectEntriesResponse {
  readonly entries: readonly { readonly project: ProjectDto }[];
}

/**
 * What kind of thing a repository is. Shown beside its name; nothing branches on it.
 *
 * Widened additively: `DAEMON`, `FRONTEND`, `CLI` and `IMAGE` are the new names.
 */
export type RepositoryArchetype =
  | 'PROJECT'
  | 'SERVICE'
  | 'LIBRARY'
  | 'SERVICE_TEMPLATE'
  | 'FORK'
  | 'DAEMON'
  | 'FRONTEND'
  | 'CLI'
  | 'IMAGE';

/**
 * A repository.
 *
 * `id` is the git-host directory name, and it is the string qits-workspaces scopes its workspace
 * list by. `mainBranch` is the branch an integrate targets — displayed so the page can name the
 * destination rather than assuming the string "main".
 */
export interface RepositoryDto {
  readonly id: string;
  readonly name: string | null;
  /** The clone url. */
  readonly backupUrl: string;
  readonly mainBranch: string;
  readonly archetype: RepositoryArchetype;
  readonly projectId: string;
}

/**
 * One line of the wrapper's `.gitmodules`, as qits-projects read it at the wrapper's main tip.
 *
 * Declared for completeness of the shape; this app reads none of it. `repositoryId` is null for an
 * entry no repository row answers to, which is the drift the projects SPA's reconcile resolves.
 */
export interface WrapperEntryDto {
  readonly path: string;
  readonly name: string;
  readonly repositoryId: string | null;
}

/**
 * The project's wrapper repository, and what its `.gitmodules` says.
 *
 * **`repositoryId` is how a wrapper is identified, and it is the only way.** A wrapper is named
 * `<slug>-<slug>` and carries the `PROJECT` archetype, but neither is the rule: the service answers
 * the wrapper here, per project, and a client that matched a name or an archetype would be
 * re-deriving a fact it was handed.
 *
 * Null for a project with no wrapper at all — an older project, which can hold no aggregate
 * workspace because there is no manifest to branch.
 */
export interface WrapperDto {
  readonly repositoryId: string;
  readonly branch: string;
  readonly entries: readonly WrapperEntryDto[];
}

/** projects' repository list envelope, plus the wrapper the rows belong to. */
export interface RepositoryEntriesResponse {
  readonly entries: readonly { readonly repository: RepositoryDto }[];
  readonly wrapper: WrapperDto | null;
}

/**
 * One branch of a repository, as qits-projects lists it.
 *
 * The overview joins this to the workspace list by {@link name}, and that is the only field it can
 * rely on: `parent`, `ahead` and `behind` need a server-side enrichment bean that the deployed
 * service does not have, so they arrive null and `canCleanup` arrives false. They are declared
 * because the endpoint promises them, and drawn only when they are actually there — a branch shown
 * as "up to date" because nobody measured it would be the tree's one outright lie.
 */
export interface BranchDto {
  readonly name: string;
  readonly canCleanup: boolean;
  readonly parent: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}

/** The branch list's envelope — a bare array under `branches`, not projects' `entries` wrapper. */
export interface BranchesResponse {
  readonly branches: readonly BranchDto[];
}

/**
 * What creating a workspace takes.
 *
 * **`repositoryId` rides in the body**, unlike the listing's query parameter: a create carries its
 * scope in the payload, and the repository is not a filter on a POST.
 *
 * `id` is the requested *label*, not an identifier — the created workspace's identifier comes back
 * in the answer. `adoptExisting` is what tells the service to take over a branch that already
 * exists instead of forking a fresh one, which is the whole of the overview's create action: the
 * branch is already there, and it is the workspace that is missing.
 */
export interface CreateWorkspaceRequest {
  readonly repositoryId: string;
  readonly id: string;
  readonly parent: string;
  readonly branch: string;
  readonly preamble: string;
  readonly adoptExisting: boolean;
  readonly branchTree?: boolean;

  /**
   * Ask for **admin mode**: the workspace's container is launched with the host's docker socket
   * bound into it, so platform administration can be done from inside the workspace.
   *
   * Optional and **omitted means no** — a body without it creates an ordinary workspace, which is
   * what every caller on this SPA but the ad-hoc creator's checkbox sends. The service decides it
   * once, at creation; no request afterwards can promote a workspace.
   */
  readonly admin?: boolean;
}

/** What a create answers: the workspace it just made. */
export interface CreateWorkspaceResponse {
  readonly workspace: WorkspaceDto;
}

/**
 * One repository, read by id.
 *
 * The list page reaches a repository through its project, because a person picking one starts from
 * the projects. The detail route has only the repository id in its URL and no project at all — so
 * it reads the repository directly, which is one request instead of two and works on a deep link
 * from anywhere.
 */
export interface RepositoryResponse {
  readonly repository: RepositoryDto;
}
