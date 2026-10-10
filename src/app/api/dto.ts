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

/** A workspace's resolution state. A slot stays `ACTIVE` until its last agent is gone. */
export type WorkspaceStatus = 'ACTIVE' | 'INTEGRATED' | 'ABANDONED';

/** The container's runtime state, independent of {@link WorkspaceStatus}. */
export type WorkspaceRuntimeStatus =
  'RUNNING' | 'STOPPED' | 'PROVISIONING' | 'FAILED' | 'QUEUED' | 'UNAVAILABLE';

/**
 * Where a workspace's container runs, decided at create and never changed: `DIRECT` on the platform
 * host through qits-containers, `RUNNER` on a workspace runner's own node.
 *
 * **The service decides it unconditionally; the create request no longer chooses it.** Every
 * regular workspace is placed on a runner, full stop — asking for `DIRECT` on one is refused with a
 * 400. An admin workspace is the opposite: always `DIRECT`.
 *
 * Two runtime states exist only for `RUNNER`. `QUEUED` is persisted — the workspace was asked to
 * start and waits for a slot on its runner (or, never placed yet, for any runner). `UNAVAILABLE` is
 * computed and never stored: the owning runner has been offline beyond its reconnect grace, and the
 * workspace is sticky to it, so nothing reassigns it and its verbs answer 409 until it is back.
 *
 * **`UNAVAILABLE` is not "no session".** The in-container daemon's control socket rides the edge,
 * not the runner, so `daemonConnectedAt`, `daemonVersion`, `clean` and `agentActivity` can all still
 * be live on an `UNAVAILABLE` row — the terminal, files and agent surface keep working even while
 * the runner that would restart or recreate the container is unreachable. `daemonConnectedAt !==
 * null` is the one fact that says so; its absence under `UNAVAILABLE` is what actually means the
 * session is gone.
 */
export type WorkspacePlacement = 'DIRECT' | 'RUNNER';

/** The runner a `RUNNER` workspace is placed on, by id and by the name the runners page shows. */
export interface WorkspaceRunnerRefDto {
  readonly id: string;
  readonly name: string;
}

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
 * `id` is the identifier every route addresses. `workspaceId` is the *label* (`ws-<id>` for a slot):
 * displayed, never used to address anything.
 *
 * A slot (qits-1152) has no branch, parent, ahead/behind or work item: those are each agent's. The
 * fields stay for workspaces made before the change.
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

  /**
   * Where the container runs, and on which runner. **Optional**, for the reason `admin` is: a
   * service that predates placement answers none of the three, and every such row is `DIRECT` —
   * so a row is runner-placed only when `placement` is literally `'RUNNER'`.
   *
   * `runner` is null for every `DIRECT` row and for a `RUNNER` row no runner has taken yet;
   * `queuedAt` is when a `QUEUED` row was last asked to start, and null otherwise.
   */
  readonly placement?: WorkspacePlacement;
  readonly runner?: WorkspaceRunnerRefDto | null;
  readonly queuedAt?: string | null;
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

  /**
   * Where the workspace ran. **Not answered by qits-workspaces yet** — its history record predates
   * placement — and optional for that reason: absent reads as `DIRECT`, which is what every row made
   * before runners was. It is what lets the resolved page say why a runner-placed workspace has no
   * archived agent sessions, rather than drawing an empty list that reads as "none ran".
   */
  readonly placement?: WorkspacePlacement;
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
 * list by.
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

/** A node's agent CLI login, as its runner last probed it. `null` is a harness it did not report. */
export type RunnerLoginPresence = 'PRESENT' | 'ABSENT' | 'UNKNOWN';

/**
 * The agent logins on a runner's node. The operator logs in once per node, into the runner's own
 * `dot_claude` volume that its workspaces share; the platform never carries the secret, so this is
 * only what the runner says it found, and when.
 */
export interface WorkspaceRunnerLoginDto {
  readonly claude: RunnerLoginPresence | null;
  readonly kimi: RunnerLoginPresence | null;
  readonly checkedAt: string | null;
}

/**
 * One workspace runner, as `GET /workspaces/api/runners` lists it — copied field-for-field from
 * qits-workspaces' `WorkspaceRunnerDto`.
 *
 * `eligible` is the service's own reading of "can take a workspace now": registered, at least one
 * slot, not quarantined. `pinnedVersion` is the runner version the service pins; a connected runner
 * reporting a different `version` is about to be rolled over. `running` counts its containers that
 * hold a slot, `owned` its ACTIVE workspaces, `queued` the ones waiting for a slot on it.
 * `loginCommand`/`kimiLoginCommand` are null until the runner reported its `dot_claude` volume.
 * `loginCommandPending` is true when that volume is known but the commands are still withheld
 * because the runner has not yet got the workspace image onto its node; optional, absent means
 * false, so the SPA keeps working against a server that predates the field.
 *
 * `workspaceMemoryLimit` is the memory cap a workspace container on this runner gets — a docker
 * size such as `8g` or `8192m` — mirrored from qits-ci-frontend's `stepMemoryLimit`. `null` means
 * the platform default. `workspaceMemorySwapLimit` is the TOTAL memory+swap ceiling, docker's own
 * `--memory-swap`: `null` means no swap beyond whatever the memory cap is, and the literal `-1`
 * means unlimited swap.
 */
export interface WorkspaceRunnerDto {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly slots: number;
  readonly workspaceMemoryLimit: string | null;
  readonly workspaceMemorySwapLimit: string | null;
  readonly version: string | null;
  readonly arch: string | null;
  readonly dotClaudeVolume: string | null;
  readonly login: WorkspaceRunnerLoginDto | null;
  readonly registered: boolean;
  readonly registeredAt: string | null;
  readonly quarantined: boolean;
  readonly quarantinedAt: string | null;
  readonly quarantineReason: string | null;
  readonly eligible: boolean;
  readonly lastSeenAt: string | null;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthCheckOk: boolean | null;
  readonly createdAt: string;
  readonly connected: boolean;
  readonly connectedSince: string | null;
  readonly pinnedVersion: string;
  readonly running: number;
  readonly owned: number;
  readonly queued: number;
  readonly loginCommand: string | null;
  readonly kimiLoginCommand: string | null;
  readonly loginCommandPending?: boolean;
  readonly health?: WorkspaceRunnerHealthDto | null;
}

/**
 * One named check inside a runner's last health result, as the runner list carries it — the
 * check's own structured `data` (qits-862, e.g. `nodeInventory`'s containers and volumes) is not
 * repeated here; {@link WorkspaceRunnerHealthCheckDetailDto} is where that lives.
 */
export interface WorkspaceRunnerHealthCheckDto {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * The last health check qits-workspaces ran against a runner, mirroring qits-ci's runner health.
 * Optional on {@link WorkspaceRunnerDto} and absent on a server older than qits-862; `null` for a
 * runner never checked.
 */
export interface WorkspaceRunnerHealthDto {
  readonly at: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly checks: readonly WorkspaceRunnerHealthCheckDto[];
}

/** What queuing an on-demand health check answers: the id the result is read back by. */
export interface RunnerHealthcheckResponse {
  readonly requestId: string;
}

/** The containers `GET …/health`'s `nodeInventory` check reports, one per container on the node. */
export interface NodeInventoryContainerDto {
  readonly name: string;
  readonly id: string;
  readonly rowId: string | null;
  readonly state: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly image: string;
}

/** One volume `nodeInventory` reports. */
export interface NodeInventoryVolumeDto {
  readonly name: string;
  readonly rowId: string | null;
  readonly createdAt: string | null;
}

/** The runner's own container, as `nodeInventory` reports it. */
export interface NodeInventoryRunnerContainerDto {
  readonly name: string;
  readonly id: string;
  readonly version: string | null;
  readonly startedAt: string | null;
}

/** The `nodeInventory` check's `data` — the node's containers, volumes and the runner's own container. */
export interface NodeInventoryDto {
  readonly containers: readonly NodeInventoryContainerDto[];
  readonly volumes: readonly NodeInventoryVolumeDto[];
  readonly runnerContainer: NodeInventoryRunnerContainerDto | null;
}

/**
 * One check as `GET /workspaces/api/runners/{id}/health` carries it — the same fields as
 * {@link WorkspaceRunnerHealthCheckDto}, plus whatever structured data that check gathered.
 * `nodeInventory`'s is {@link NodeInventoryDto}; every other check's is read generically.
 */
export interface WorkspaceRunnerHealthCheckDetailDto {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly data: unknown;
}

/** The full detail `GET /workspaces/api/runners/{id}/health` answers. */
export interface WorkspaceRunnerHealthDetailDto {
  readonly at: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly requestId: string;
  readonly checks: readonly WorkspaceRunnerHealthCheckDetailDto[];
}

/**
 * What a runner create takes. Slots are the containers it may run at once. `workspaceMemoryLimit`
 * and `workspaceMemorySwapLimit` are sent only when typed, trimmed; absent is the platform default
 * on both — see {@link WorkspaceRunnerDto}.
 */
export interface CreateRunnerRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly slots: number;
  readonly workspaceMemoryLimit?: string;
  readonly workspaceMemorySwapLimit?: string;
}

/**
 * What a runner PATCH takes: only the fields that are sent change. `workspaceMemoryLimit` and
 * `workspaceMemorySwapLimit` as an empty string each clear the one they name back to the platform
 * default; absent leaves it as it was.
 */
export interface PatchRunnerRequest {
  readonly slots?: number;
  readonly description?: string | null;
  readonly workspaceMemoryLimit?: string;
  readonly workspaceMemorySwapLimit?: string;
}

/**
 * What a create and a token rotation answer. `registrationToken` and `installLine` are single-use
 * and are never answered again — a page that loses them makes a new one by rotating.
 */
export interface RunnerRegistrationDto {
  readonly runner: WorkspaceRunnerDto;
  readonly registrationToken: string;
  readonly installLine: string;
}

/** An agent's lifecycle (qits-1152): `OBSOLETE` once its branches are released, `REMOVED` after cleanup. */
export type AgentState = 'ACTIVE' | 'OBSOLETE' | 'REMOVED';

/** Whether an agent holds its workspace's one harness slot. `QUEUED` has no workspace yet. */
export type AgentRunState = 'QUEUED' | 'RUNNING' | 'YIELDED';

/** The coding-agent harness an agent runs. */
export type AgentHarness = 'CLAUDE' | 'KIMI';

/** One branch an agent pushed, one per repository it touched. */
export interface AgentBranchDto {
  readonly repositoryId: string | null;
  readonly branch: string;
  readonly sha?: string | null;
  readonly pushedAt?: string | null;
}

/**
 * One agent: a work item's coding agent and its worktree inside a workspace.
 *
 * `workId` is the work item's UUID and `entityId` its qualified id (`qits-617`), which is what a
 * person reads. `workspaceRowId` is null while the agent is `QUEUED`.
 */
export interface AgentDto {
  readonly agentId: string;
  readonly workspaceRowId: number | null;
  readonly repositoryId: string;
  readonly workId: string;
  readonly entityId?: string | null;
  readonly ticketId?: string | null;
  readonly epicId?: string | null;
  readonly wrapperBranch: string;
  readonly branches: readonly AgentBranchDto[];
  readonly state: AgentState;
  readonly runState: AgentRunState;
  readonly admin: boolean;
  readonly harness?: AgentHarness | null;
  readonly sessionId?: string | null;
  readonly entityTitle?: string | null;
  readonly entityStatus?: string | null;
  readonly entityBlocked?: boolean | null;
  readonly activity?: AgentActivityState | null;
  readonly waitingSince?: string | null;
  readonly lastActivityAt?: string | null;
  readonly createdAt?: string | null;
  readonly obsoleteAt?: string | null;
  readonly removedAt?: string | null;
}

/** `GET /workspaces/api/agents` answers `{agents: […]}`, newest first. */
export interface AgentsResponse {
  readonly agents: readonly AgentDto[];
}

/** What happened to a new agent's start. `QUEUED`: no workspace slot is free yet. */
export type AgentLaunch = 'SCHEDULED' | 'SKIPPED_RUNNING' | 'QUEUED';

/** What `POST /workspaces/api/agents` answers. `fresh: false` is the item's existing agent. */
export interface AgentDispatchDto {
  readonly agent: AgentDto;
  readonly fresh: boolean;
  readonly agentLaunch: AgentLaunch;
  readonly agentIdentity?: string | null;
}

/**
 * A person's request for an agent on an existing work item (D24).
 *
 * `workId` is the item's UUID, `entityId` its qualified id and `kind` `TICKET` or `EPIC`; the service
 * derives the wrapper branch (`ticket/<entityId>`) from the last two.
 */
export interface CreateAgentRequest {
  readonly repositoryId: string;
  readonly workId: string;
  readonly entityId?: string;
  readonly kind?: 'TICKET' | 'EPIC';
  readonly wrapperBranch?: string;
  readonly admin: boolean;
  readonly harness?: AgentHarness;
  readonly instruction?: string;
}

/** What `POST /workspaces/api/agent-dispatches/delivery` answers. `agentId: null`: nobody works on it. */
export interface AgentDeliveryDto {
  readonly agentId: string | null;
  readonly delivered: boolean;
  readonly launched: boolean;
  readonly resumed: boolean;
  readonly detail?: string | null;
}

/** A declared wait's state (qits-1153). */
export type AgentWaitState = 'OPEN' | 'MATCHED' | 'TIMED_OUT' | 'CANCELLED';

/** What an agent waits on (qits-1153). Only what this page shows is typed. */
export interface AgentWaitDto {
  readonly id: string;
  readonly agentId: string;
  readonly label?: string | null;
  readonly selection?: { readonly event?: string } | null;
  readonly state: AgentWaitState;
  readonly createdAt?: string | null;
  readonly expiresAt?: string | null;
}

/** The work item kinds qits-projects knows. Only tickets and epics get an agent. */
export type WorkArchetype = 'EPIC' | 'TICKET' | 'FEATURE' | 'TASK' | 'CAMPAIGN';

/** One work item, as `GET /projects/api/work/{qualifiedId}` answers it. Only what this app reads. */
export interface WorkItemDto {
  readonly id: string;
  readonly archetype: WorkArchetype;
  readonly projectId: string;
  readonly qualifiedId: string;
  readonly title?: string | null;
  readonly status?: string | null;
  readonly blocked?: boolean | null;
}
