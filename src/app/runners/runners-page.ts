import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  QITS_SCOPE,
  QitsBadge,
  QitsButton,
  scopeCommands,
  type QitsBadgeTone,
} from '@qits/ui-components';
import type {
  NodeInventoryDto,
  RunnerLoginPresence,
  RunnerRegistrationDto,
  WorkspaceRunnerDto,
  WorkspaceRunnerHealthCheckDetailDto,
  WorkspaceRunnerHealthCheckDto,
  WorkspaceRunnerHealthDetailDto,
} from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { RunnersApi } from '../api/runners-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { NONE, relativeSince } from '../ui/format';
import { LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';
import { Viewer } from '../ui/viewer';

/**
 * How often the runner list is re-read while the page is visible. Five seconds: there are no runner
 * events on qits-events, so this poll is the only way a runner connecting, a slot filling or a login
 * landing reaches the screen.
 */
export const RUNNERS_POLL_INTERVAL_MS = 5_000;

/**
 * `[a-z][a-z0-9-]{0,63}` — qits-workspaces' own rule for a runner's name, mirrored so a bad one is
 * caught before the round trip. The service is still the authority.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The service's floor. A runner with 0 slots is drained: connected, taking nothing new. */
const MIN_SLOTS = 0;

/** The refusal a delete answers while the runner still owns an ACTIVE workspace. */
const OWNS_WORKSPACES = 'RUNNER_OWNS_WORKSPACES';

/** The refusal an on-demand health check answers while the runner holds no socket to be asked over. */
const RUNNER_UNAVAILABLE = 'RUNNER_UNAVAILABLE';

/** The sentence shown for {@link RUNNER_UNAVAILABLE}, in place of the server's bare code. */
const RUNNER_UNAVAILABLE_MESSAGE = 'This runner is not connected right now.';

/** The name `nodeInventory`'s check carries — the one check this page renders specially. */
const NODE_INVENTORY_CHECK = 'nodeInventory';

/** The sentence for a quarantined runner the service gave no reason for — a new one. */
const AWAITING_FIRST_HEALTHCHECK = 'awaiting its first health check';

/**
 * A workspace memory or memory+swap limit's own docker-size grammar — digits and an optional
 * `b`/`k`/`m`/`g` — mirrored from qits-ci-frontend's `STEP_MEMORY_LIMIT_PATTERN` for the same
 * reason: the service additionally refuses anything under docker's 6 MiB floor, and renders that
 * refusal itself when it does.
 */
const DOCKER_SIZE_PATTERN = /^[0-9]{1,15}[bkmgBKMG]?$/;

/** The one swap value with no docker-size shape of its own: unlimited swap. */
const UNLIMITED_SWAP = '-1';

/** Why a typed workspace memory limit is refused before the round trip, or `''` when it is not. */
function workspaceMemoryLimitProblemOf(value: string): string {
  const limit = value.trim();
  return limit === '' || DOCKER_SIZE_PATTERN.test(limit)
    ? ''
    : 'A docker size: digits and an optional unit b, k, m or g — e.g. 8g or 8192m.';
}

/** A docker size's bytes, so a swap limit can be checked against the memory limit it must cover. */
function bytesOf(size: string): number {
  const match = /^([0-9]{1,15})([bkmgBKMG]?)$/.exec(size);
  if (!match) {
    return NaN;
  }
  const [, digits, unit] = match;
  const multiplier =
    { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit.toLowerCase()] ?? NaN;
  return Number(digits) * multiplier;
}

/**
 * Why a typed workspace memory+swap limit is refused, or `''` when it is not: not a docker size
 * and not `-1`; set with no memory limit of its own, since swap is the total of both and the
 * service refuses one without the other; or set below the memory limit it has to cover.
 */
function workspaceMemorySwapLimitProblemOf(memory: string, swap: string): string {
  const limit = swap.trim();
  if (limit === '') {
    return '';
  }
  if (limit !== UNLIMITED_SWAP && !DOCKER_SIZE_PATTERN.test(limit)) {
    return 'A docker size, or -1 for unlimited swap — e.g. 8g, 8192m or -1.';
  }
  const memoryLimit = memory.trim();
  if (memoryLimit === '') {
    return 'Needs a workspace memory limit too — this is the total of both.';
  }
  if (limit === UNLIMITED_SWAP || !DOCKER_SIZE_PATTERN.test(memoryLimit)) {
    return '';
  }
  return bytesOf(limit) >= bytesOf(memoryLimit)
    ? ''
    : 'Must be at least the workspace memory limit — this is the total of both.';
}

/** What the row says about a runner's workspace memory cap: its own, or the platform's. */
function workspaceMemoryDisplayOf(runner: WorkspaceRunnerDto): string {
  return runner.workspaceMemoryLimit
    ? `${runner.workspaceMemoryLimit} memory`
    : 'platform default memory';
}

/** What the row adds for swap, once the runner has one set — `null` draws nothing. */
function workspaceMemorySwapDisplayOf(runner: WorkspaceRunnerDto): string | null {
  return runner.workspaceMemorySwapLimit ? `${runner.workspaceMemorySwapLimit} swap` : null;
}

/** A badge: what it says and how loud. */
interface Badge {
  readonly label: string;
  readonly tone: QitsBadgeTone;
}

/**
 * Connected now, registered but offline, or never connected at all. Green only for the one that is
 * actually holding a socket — the state a workspace placed on it depends on.
 */
function connectivityOf(runner: WorkspaceRunnerDto): Badge {
  if (runner.connected) {
    return { label: 'connected', tone: 'success' };
  }
  return runner.registered
    ? { label: 'offline', tone: 'warning' }
    : { label: 'never connected', tone: 'neutral' };
}

/** How a login presence reads. `null` is a harness the runner has not reported on. */
function presenceOf(presence: RunnerLoginPresence | null): Badge {
  switch (presence) {
    case 'PRESENT':
      return { label: 'logged in', tone: 'success' };
    case 'ABSENT':
      return { label: 'not logged in', tone: 'warning' };
    case 'UNKNOWN':
      return { label: 'unknown', tone: 'neutral' };
    default:
      return { label: 'not reported', tone: 'neutral' };
  }
}

/**
 * The owning workspaces a refused delete names, read off the 409 body; `null` when this was not that
 * refusal. The ids are the body's `workspaceIds`, the code its `code` (or, failing that, the marker
 * inside the message).
 */
function owningWorkspaceIds(error: unknown): readonly number[] | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { code, message, workspaceIds } = body as {
    code?: unknown;
    message?: unknown;
    workspaceIds?: unknown;
  };
  const matches =
    code === OWNS_WORKSPACES || (typeof message === 'string' && message.includes(OWNS_WORKSPACES));
  if (!matches) {
    return null;
  }
  return Array.isArray(workspaceIds)
    ? workspaceIds.filter((id): id is number => typeof id === 'number')
    : [];
}

/**
 * The friendly sentence for an on-demand health check refused with {@link RUNNER_UNAVAILABLE} —
 * the runner is registered but not connected right now, so there is no socket to send the check
 * over. `null` when this was some other failure, which falls back to the generic rendering.
 */
function runnerUnavailableMessage(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { code, message } = body as { code?: unknown; message?: unknown };
  const matches =
    code === RUNNER_UNAVAILABLE ||
    (typeof message === 'string' && message.includes(RUNNER_UNAVAILABLE));
  return matches ? RUNNER_UNAVAILABLE_MESSAGE : null;
}

/** The once-only panel: whose registration it is, and the two things that are never answered again. */
interface InstallPanel {
  readonly runnerName: string;
  readonly registrationToken: string;
  readonly installLine: string;
}

/** One workspace a refused delete named: its row id, and where it lives when that could be found. */
export interface OwningWorkspace {
  readonly id: number;
  readonly label: string;
  /** The repository whose detail route opens it; null when no wrapper's list holds it. */
  readonly repositoryId: string | null;
}

/** A runner's editable fields, held as a draft until saved or discarded. */
interface EditDraft {
  readonly slots: number;
  readonly description: string;
  /** As typed; blank is the platform default. */
  readonly workspaceMemoryLimit: string;
  /** As typed; blank is no swap beyond the memory cap, `-1` is unlimited swap. */
  readonly workspaceMemorySwapLimit: string;
}

/** One check, drawn as a badge plus its detail sentence. */
interface CheckDisplay {
  readonly name: string;
  readonly label: string;
  readonly tone: QitsBadgeTone;
  readonly detail: string;
}

/** `check.ok` drawn `passed`/success or `failed`/danger — the same vocabulary the overall badge uses. */
function checkDisplayOf(check: WorkspaceRunnerHealthCheckDto): CheckDisplay {
  return {
    name: check.name,
    label: check.ok ? 'passed' : 'failed',
    tone: check.ok ? 'success' : 'danger',
    detail: check.detail,
  };
}

/** A flat `key: value` pair, for a check's `data` this page does not render a dedicated table for. */
type CompactEntry = readonly [key: string, value: string];

/** `data` read as compact entries — nested objects and arrays stringified rather than walked further. */
function compactEntriesOf(data: unknown): readonly CompactEntry[] {
  if (typeof data !== 'object' || data === null) {
    return data === undefined ? [] : [['value', String(data)]];
  }
  return Object.entries(data as Record<string, unknown>).map(([key, value]) => [
    key,
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  ]);
}

/** The node-details panel's content: `nodeInventory` rendered as tables, every other check compactly. */
interface NodeDetailsDisplay {
  readonly inventory: NodeInventoryDto | null;
  readonly otherChecks: readonly {
    readonly name: string;
    readonly check: CheckDisplay;
    readonly entries: readonly CompactEntry[];
  }[];
}

/** Splits a health detail's checks into {@link NODE_INVENTORY_CHECK} and everything else. */
function nodeDetailsDisplayOf(detail: WorkspaceRunnerHealthDetailDto): NodeDetailsDisplay {
  const inventoryCheck = detail.checks.find(
    (check): check is WorkspaceRunnerHealthCheckDetailDto => check.name === NODE_INVENTORY_CHECK,
  );
  const inventory =
    inventoryCheck && typeof inventoryCheck.data === 'object' && inventoryCheck.data !== null
      ? (inventoryCheck.data as NodeInventoryDto)
      : null;
  const otherChecks = detail.checks
    .filter((check) => check.name !== NODE_INVENTORY_CHECK)
    .map((check) => ({
      name: check.name,
      check: checkDisplayOf(check),
      entries: compactEntriesOf(check.data),
    }));
  return { inventory, otherChecks };
}

/**
 * The workspace runners: every node qits-workspaces can place a workspace on, a form to register
 * another, and the one-time install line that registering — or rotating a token — answers.
 *
 * Modelled on qits-ci-frontend's runners page, as a copy: the two registries are different services
 * with different DTOs, and a shared component is not worth what it would couple.
 *
 * <h2>The install line is shown once</h2>
 *
 * Create and rotate both answer a single-use registration token inside a one-line install. This
 * page holds it in exactly one signal — {@link panel} — while the panel showing it is open. Closing
 * the panel drops it, nothing persists it, and a reload loses it: the page says so, because the
 * remedy (rotate) is only obvious to somebody who knows the line is gone for good.
 *
 * <h2>The login is per node</h2>
 *
 * Each runner owns a node-local `dot_claude` volume its workspaces share. The operator logs in once
 * on the node with the command the runner reports; the platform never carries the secret. So the
 * panel under each runner is only ever what the runner says it found, with the command to fix it.
 *
 * <h2>Who may press what</h2>
 *
 * Reads are for everyone who can read workspaces. Every write is `qits:admin`'s, and {@link Viewer}
 * is what decides whether those controls are drawn at all.
 */
@Component({
  selector: 'app-runners-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink],
  templateUrl: './runners-page.html',
  styleUrl: './runners-page.css',
})
export class RunnersPage {
  private readonly api = inject(RunnersApi);
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly document = inject(DOCUMENT);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly viewer = inject(Viewer);

  protected readonly admin = this.viewer.admin;
  protected readonly none = NONE;
  protected readonly minSlots = MIN_SLOTS;
  protected readonly connectivity = connectivityOf;
  protected readonly presence = presenceOf;
  protected readonly workspaceMemoryDisplay = workspaceMemoryDisplayOf;
  protected readonly workspaceMemorySwapDisplay = workspaceMemorySwapDisplayOf;

  /** Where this page's own links start — bare, or under the scope the reader came in through. */
  protected readonly home = computed<string[]>(() => [...scopeCommands(this.qitsScope.scope())]);

  /** The clock the "ago" labels are read against, moved by every poll. */
  private readonly now = signal(new Date());

  protected readonly runners = signal<Loadable<readonly WorkspaceRunnerDto[]>>(LOADING);

  // --- the create form ---

  protected readonly newName = signal('');
  protected readonly newDescription = signal('');
  protected readonly newSlots = signal(1);
  protected readonly newWorkspaceMemoryLimit = signal('');
  protected readonly newWorkspaceMemorySwapLimit = signal('');
  protected readonly creating = signal(false);
  protected readonly createError = signal('');
  private readonly submitted = signal(false);

  protected readonly nameProblem = computed(() => {
    if (!this.submitted()) {
      return '';
    }
    const name = this.newName();
    if (!name) {
      return 'A name is required.';
    }
    return NAME_PATTERN.test(name)
      ? ''
      : 'Lowercase letters, digits and hyphens, starting with a letter.';
  });

  protected readonly slotsProblem = computed(() => {
    if (!this.submitted()) {
      return '';
    }
    const slots = this.newSlots();
    return Number.isInteger(slots) && slots >= MIN_SLOTS ? '' : 'Slots must be 0 or more.';
  });

  protected readonly workspaceMemoryLimitProblem = computed(() =>
    this.submitted() ? workspaceMemoryLimitProblemOf(this.newWorkspaceMemoryLimit()) : '',
  );

  protected readonly workspaceMemorySwapLimitProblem = computed(() =>
    this.submitted()
      ? workspaceMemorySwapLimitProblemOf(
          this.newWorkspaceMemoryLimit(),
          this.newWorkspaceMemorySwapLimit(),
        )
      : '',
  );

  // --- the once-only install panel, shared by create and rotate ---

  protected readonly panel = signal<InstallPanel | null>(null);
  protected readonly copied = signal<string | null>(null);
  private copiedTimeout: ReturnType<typeof setTimeout> | null = null;

  // --- per-row state; one row's menu open at a time ---

  protected readonly openRow = signal<string | null>(null);
  protected readonly editing = signal<EditDraft | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly rowError = signal('');
  protected readonly confirmingDelete = signal(false);

  /** Touched only once a save was attempted, so the memory fields are not flagged before anyone types. */
  private readonly editSubmitted = signal(false);

  protected readonly editWorkspaceMemoryLimitProblem = computed(() => {
    const draft = this.editing();
    return draft && this.editSubmitted() ? workspaceMemoryLimitProblemOf(draft.workspaceMemoryLimit) : '';
  });

  protected readonly editWorkspaceMemorySwapLimitProblem = computed(() => {
    const draft = this.editing();
    return draft && this.editSubmitted()
      ? workspaceMemorySwapLimitProblemOf(draft.workspaceMemoryLimit, draft.workspaceMemorySwapLimit)
      : '';
  });

  /** The workspaces a refused delete named, resolved to links where a wrapper's list holds them. */
  protected readonly owners = signal<readonly OwningWorkspace[] | null>(null);

  /** Per runner, the error of its last login re-check — shown inside its login panel. */
  protected readonly loginError = signal<ReadonlyMap<string, string>>(new Map());

  // --- the on-demand health check, and the node-details panel it feeds ---

  /**
   * Runner ids with a health check this page itself just queued, mapped to the `health.at` (or the
   * legacy `lastHealthCheckAt`) seen at the moment it was queued — `null` when there was none yet.
   * A row's "Run health check" button stays disabled for as long as its entry survives here;
   * dropped once a fresher check lands (or the runner is gone), the same scheme qits-ci-frontend's
   * runners page uses, rather than a timer this page would have to guess a duration for.
   */
  protected readonly healthchecking = signal<ReadonlyMap<string, string | null>>(new Map());

  /** The on-demand health check's own error — separate from {@link rowError}, since the button that
   *  can trigger it lives outside the row's Actions menu and must show its refusal with it. */
  protected readonly healthcheckError = signal('');

  /** One row's node-details panel open at a time, keyed by runner id; `null` means none is. */
  protected readonly nodeDetailsOpen = signal<string | null>(null);

  /** Per runner, the node-details panel's own load — read lazily, the first time the panel opens. */
  protected readonly nodeDetails = signal<
    ReadonlyMap<string, Loadable<WorkspaceRunnerHealthDetailDto>>
  >(new Map());

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor() {
    void this.load();

    const onVisibilityChange = () => this.onVisibilityChange();
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stopPolling();
      if (this.copiedTimeout !== null) {
        clearTimeout(this.copiedTimeout);
      }
    });

    this.sync();
  }

  protected ago(iso: string | null): string {
    return iso ? relativeSince(iso, this.now()) : NONE;
  }

  protected async load(): Promise<void> {
    this.runners.set(LOADING);
    try {
      const runners = sortRunners(await this.api.runners());
      this.runners.set(ready(runners));
      this.now.set(new Date());
      this.reconcileHealthchecking(runners);
    } catch (error) {
      this.runners.set(failed(error));
    }
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const runners = sortRunners(await this.api.runners());
      this.runners.set(ready(runners));
      this.now.set(new Date());
      this.reconcileHealthchecking(runners);
    } catch {
      // The last list stays on screen; one missed poll is not worth a banner.
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Drops a row's pending health-check flag once a fresher check than the one seen at click time
   * lands, or once the runner is gone — see {@link healthchecking}.
   */
  private reconcileHealthchecking(runners: readonly WorkspaceRunnerDto[]): void {
    const pending = this.healthchecking();
    if (pending.size === 0) {
      return;
    }
    const byId = new Map(runners.map((runner) => [runner.id, runner] as const));
    const next = new Map(pending);
    let changed = false;
    for (const [id, seenAt] of pending) {
      const runner = byId.get(id);
      const currentAt = runner ? this.healthCheckAt(runner) : null;
      if (!runner || currentAt !== seenAt) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.healthchecking.set(next);
    }
  }

  private sync(): void {
    if (this.document.hidden) {
      this.stopPolling();
    } else {
      this.pollHandle ??= setInterval(() => void this.poll(), RUNNERS_POLL_INTERVAL_MS);
    }
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private onVisibilityChange(): void {
    if (!this.document.hidden) {
      void this.poll();
    }
    this.sync();
  }

  // --- what a row says ---

  /**
   * Whether the runner is about to be rolled over: connected, and reporting a version other than the
   * one the service pins. A runner that is offline is not updating — it is offline.
   */
  protected updating(runner: WorkspaceRunnerDto): boolean {
    return runner.connected && runner.version !== runner.pinnedVersion;
  }

  protected quarantineReason(runner: WorkspaceRunnerDto): string {
    return runner.quarantineReason ?? AWAITING_FIRST_HEALTHCHECK;
  }

  /**
   * The overall badge for a runner's last health check. `runner.health` (qits-862) is preferred
   * when the server sends it; a server that predates it sends neither `health` nor anything this
   * page could build a per-check list from, so that case falls back to the plain
   * `lastHealthCheckOk` badge it always drew — the same rendering as before this field existed.
   */
  protected healthCheck(runner: WorkspaceRunnerDto): Badge | null {
    if (runner.health) {
      return runner.health.ok
        ? { label: 'health check passed', tone: 'success' }
        : { label: 'health check failed', tone: 'danger' };
    }
    if (runner.lastHealthCheckOk === null) {
      return null;
    }
    return runner.lastHealthCheckOk
      ? { label: 'health check passed', tone: 'success' }
      : { label: 'health check failed', tone: 'danger' };
  }

  /** When the badge {@link healthCheck} draws was last taken — `runner.health`'s, or the legacy field. */
  protected healthCheckAt(runner: WorkspaceRunnerDto): string | null {
    return runner.health?.at ?? runner.lastHealthCheckAt;
  }

  /** The per-check list under the badge — empty when the server sent no `health` (yet, or ever). */
  protected checks(runner: WorkspaceRunnerDto): readonly CheckDisplay[] {
    return (runner.health?.checks ?? []).map(checkDisplayOf);
  }

  protected isHealthchecking(runner: WorkspaceRunnerDto): boolean {
    return this.healthchecking().has(runner.id);
  }

  // --- creating a runner ---

  protected async createRunner(): Promise<void> {
    this.submitted.set(true);
    if (
      this.nameProblem() ||
      this.slotsProblem() ||
      this.workspaceMemoryLimitProblem() ||
      this.workspaceMemorySwapLimitProblem()
    ) {
      return;
    }
    this.creating.set(true);
    this.createError.set('');
    // Sent only when typed: absent is the platform default on both.
    const workspaceMemoryLimit = this.newWorkspaceMemoryLimit().trim();
    const workspaceMemorySwapLimit = this.newWorkspaceMemorySwapLimit().trim();
    try {
      const created = await this.api.createRunner({
        name: this.newName(),
        description: this.newDescription() || null,
        slots: this.newSlots(),
        ...(workspaceMemoryLimit ? { workspaceMemoryLimit } : {}),
        ...(workspaceMemorySwapLimit ? { workspaceMemorySwapLimit } : {}),
      });
      this.openPanel(created);
      this.newName.set('');
      this.newDescription.set('');
      this.newSlots.set(1);
      this.newWorkspaceMemoryLimit.set('');
      this.newWorkspaceMemorySwapLimit.set('');
      this.submitted.set(false);
      await this.load();
    } catch (error) {
      this.viewer.noteRefusal(error);
      this.createError.set(`Could not register this runner — ${describeError(error)}.`);
    } finally {
      this.creating.set(false);
    }
  }

  private openPanel(registration: RunnerRegistrationDto): void {
    this.panel.set({
      runnerName: registration.runner.name,
      registrationToken: registration.registrationToken,
      installLine: registration.installLine,
    });
    this.copied.set(null);
  }

  /** Closes the panel and drops the token with it — nothing on this page holds it anywhere else. */
  protected closePanel(): void {
    this.panel.set(null);
    this.copied.set(null);
  }

  /** Copy one string; `what` names it, so the button that was pressed is the one that says "Copied". */
  protected async copy(what: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard (an insecure origin, a denied permission): the text is on screen to select.
      return;
    }
    this.copied.set(what);
    if (this.copiedTimeout !== null) {
      clearTimeout(this.copiedTimeout);
    }
    this.copiedTimeout = setTimeout(() => this.copied.set(null), 2000);
  }

  // --- the row menu ---

  protected isRowOpen(id: string): boolean {
    return this.openRow() === id;
  }

  protected toggleRow(id: string): void {
    this.openRow.set(this.openRow() === id ? null : id);
    this.editing.set(null);
    this.rowError.set('');
    this.confirmingDelete.set(false);
    this.owners.set(null);
  }

  protected startEdit(runner: WorkspaceRunnerDto): void {
    this.editing.set({
      slots: runner.slots,
      description: runner.description ?? '',
      workspaceMemoryLimit: runner.workspaceMemoryLimit ?? '',
      workspaceMemorySwapLimit: runner.workspaceMemorySwapLimit ?? '',
    });
    this.rowError.set('');
    this.editSubmitted.set(false);
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.rowError.set('');
    this.editSubmitted.set(false);
  }

  protected setEditSlots(slots: number): void {
    this.editing.update((draft) => (draft ? { ...draft, slots } : draft));
  }

  protected setEditDescription(description: string): void {
    this.editing.update((draft) => (draft ? { ...draft, description } : draft));
  }

  protected setEditWorkspaceMemoryLimit(workspaceMemoryLimit: string): void {
    this.editing.update((draft) => (draft ? { ...draft, workspaceMemoryLimit } : draft));
  }

  protected setEditWorkspaceMemorySwapLimit(workspaceMemorySwapLimit: string): void {
    this.editing.update((draft) => (draft ? { ...draft, workspaceMemorySwapLimit } : draft));
  }

  protected async saveEdit(runner: WorkspaceRunnerDto): Promise<void> {
    this.editSubmitted.set(true);
    const draft = this.editing();
    if (!draft) {
      return;
    }
    if (!Number.isInteger(draft.slots) || draft.slots < MIN_SLOTS) {
      this.rowError.set('Slots must be 0 or more.');
      return;
    }
    if (
      workspaceMemoryLimitProblemOf(draft.workspaceMemoryLimit) ||
      workspaceMemorySwapLimitProblemOf(draft.workspaceMemoryLimit, draft.workspaceMemorySwapLimit)
    ) {
      return;
    }
    // Sent only when it moved — an empty string is the clear, back to the platform default.
    const workspaceMemoryLimit = draft.workspaceMemoryLimit.trim();
    const memoryChanged = workspaceMemoryLimit !== (runner.workspaceMemoryLimit ?? '');
    const workspaceMemorySwapLimit = draft.workspaceMemorySwapLimit.trim();
    const swapChanged = workspaceMemorySwapLimit !== (runner.workspaceMemorySwapLimit ?? '');
    await this.act('save', 'Could not save', async () => {
      await this.api.patchRunner(runner.id, {
        slots: draft.slots,
        description: draft.description || null,
        ...(memoryChanged ? { workspaceMemoryLimit } : {}),
        ...(swapChanged ? { workspaceMemorySwapLimit } : {}),
      });
      this.editing.set(null);
    });
  }

  protected async rotateToken(runner: WorkspaceRunnerDto): Promise<void> {
    await this.act('rotate', 'Could not rotate the registration token', async () => {
      this.openPanel(await this.api.rotateToken(runner.id));
      this.openRow.set(null);
    });
  }

  protected async greenlight(runner: WorkspaceRunnerDto): Promise<void> {
    await this.act('greenlight', 'Could not greenlight this runner', () =>
      this.api.greenlight(runner.id),
    );
  }

  /**
   * Queue a health check on demand. The button disables for as long as {@link isHealthchecking}
   * says it is pending — cleared by {@link reconcileHealthchecking} once a fresher result lands with
   * a later poll, not by this call's own round trip, since the check itself runs on the runner's
   * node and the POST only queues it. A 409 ({@link RUNNER_UNAVAILABLE}) means the runner is not
   * connected right now; that sentence is shown rather than the bare code.
   */
  protected async runHealthCheck(runner: WorkspaceRunnerDto): Promise<void> {
    if (this.isHealthchecking(runner)) {
      return;
    }
    this.healthcheckError.set('');
    this.healthchecking.update((map) =>
      new Map(map).set(runner.id, this.healthCheckAt(runner)),
    );
    try {
      await this.api.healthCheck(runner.id);
    } catch (error) {
      this.viewer.noteRefusal(error);
      this.healthcheckError.set(
        runnerUnavailableMessage(error) ?? `Could not run a health check — ${describeError(error)}.`,
      );
      this.healthchecking.update((map) => {
        const next = new Map(map);
        next.delete(runner.id);
        return next;
      });
    }
  }

  // --- node details: the other half of a health result, loaded lazily per row ---

  protected isNodeDetailsOpen(runner: WorkspaceRunnerDto): boolean {
    return this.nodeDetailsOpen() === runner.id;
  }

  protected nodeDetailsState(
    runner: WorkspaceRunnerDto,
  ): Loadable<WorkspaceRunnerHealthDetailDto> {
    return this.nodeDetails().get(runner.id) ?? LOADING;
  }

  /** `nodeInventory`'s containers/volumes, and every other check's `data` compactly — once loaded. */
  protected nodeDetailsDisplay(detail: WorkspaceRunnerHealthDetailDto): NodeDetailsDisplay {
    return nodeDetailsDisplayOf(detail);
  }

  /** Opens the panel and, the first time, loads it; closing never drops what was already read. */
  protected async toggleNodeDetails(runner: WorkspaceRunnerDto): Promise<void> {
    if (this.isNodeDetailsOpen(runner)) {
      this.nodeDetailsOpen.set(null);
      return;
    }
    this.nodeDetailsOpen.set(runner.id);
    await this.loadNodeDetails(runner);
  }

  protected async retryNodeDetails(runner: WorkspaceRunnerDto): Promise<void> {
    await this.loadNodeDetails(runner);
  }

  private async loadNodeDetails(runner: WorkspaceRunnerDto): Promise<void> {
    const state = this.nodeDetails().get(runner.id);
    if (state && (state.kind === 'ready' || state.kind === 'loading')) {
      return;
    }
    this.nodeDetails.update((map) => new Map(map).set(runner.id, LOADING));
    try {
      const detail = await this.api.health(runner.id);
      this.nodeDetails.update((map) => new Map(map).set(runner.id, ready(detail)));
    } catch (error) {
      this.nodeDetails.update((map) => new Map(map).set(runner.id, failed(error)));
    }
  }

  protected askDelete(): void {
    this.confirmingDelete.set(true);
  }

  protected dismissDelete(): void {
    this.confirmingDelete.set(false);
  }

  protected async confirmDelete(runner: WorkspaceRunnerDto): Promise<void> {
    this.busy.set('delete');
    this.rowError.set('');
    this.owners.set(null);
    try {
      await this.api.deleteRunner(runner.id);
      this.openRow.set(null);
      this.confirmingDelete.set(false);
      await this.load();
    } catch (error) {
      this.viewer.noteRefusal(error);
      const ids = owningWorkspaceIds(error);
      if (ids) {
        this.confirmingDelete.set(false);
        this.owners.set(await this.resolveOwners(ids));
      } else {
        this.rowError.set(`Could not delete this runner — ${describeError(error)}.`);
      }
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Turn the 409's row ids into links.
   *
   * The refusal names ids alone, and the detail route needs the workspace's repository too — which
   * no workspace read answers. So each project's wrapper list is read, because the wrapper is what an
   * aggregate workspace branches, and an id found there gets its link and its branch name. An id no
   * wrapper holds is still listed, by number: the fact that it blocks the delete is worth more than
   * the link.
   */
  private async resolveOwners(ids: readonly number[]): Promise<readonly OwningWorkspace[]> {
    const found = new Map<number, OwningWorkspace>();
    try {
      const projects = await this.projectsApi.projects();
      const wrappers = await Promise.all(
        projects.map(async (project) => (await this.projectsApi.components(project.id)).wrapper),
      );
      for (const wrapper of wrappers) {
        if (!wrapper || ids.every((id) => found.has(id))) {
          continue;
        }
        for (const workspace of await this.workspacesApi.workspaces(wrapper.repositoryId)) {
          if (ids.includes(workspace.id)) {
            found.set(workspace.id, {
              id: workspace.id,
              label: workspace.branch ?? workspace.workspaceId,
              repositoryId: wrapper.repositoryId,
            });
          }
        }
      }
    } catch {
      // The ids are still the answer; a failed lookup only costs the links.
    }
    return ids.map((id) => found.get(id) ?? { id, label: `workspace #${id}`, repositoryId: null });
  }

  /** Re-probe a node's logins. The answer arrives with a later poll, not with this call. */
  protected async recheckLogin(runner: WorkspaceRunnerDto): Promise<void> {
    this.busy.set(`login:${runner.id}`);
    this.loginError.update((map) => {
      const next = new Map(map);
      next.delete(runner.id);
      return next;
    });
    try {
      await this.api.loginCheck(runner.id);
    } catch (error) {
      this.viewer.noteRefusal(error);
      this.loginError.update((map) =>
        new Map(map).set(runner.id, `Could not re-check — ${describeError(error)}.`),
      );
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * One row verb: mark it busy, keep the reason on failure, and re-read either way — a refused
   * press may still have moved something, and the row that produced the refusal is the least
   * trustworthy thing on screen.
   */
  private async act(which: string, failure: string, call: () => Promise<unknown>): Promise<void> {
    this.busy.set(which);
    this.rowError.set('');
    try {
      await call();
    } catch (error) {
      this.viewer.noteRefusal(error);
      this.rowError.set(`${failure} — ${describeError(error)}.`);
    } finally {
      this.busy.set(null);
      await this.poll();
    }
  }
}

/** Alphabetical by name, so a poll never reshuffles the rows under the reader's pointer. */
function sortRunners(runners: readonly WorkspaceRunnerDto[]): readonly WorkspaceRunnerDto[] {
  return [...runners].sort((a, b) => a.name.localeCompare(b.name));
}
