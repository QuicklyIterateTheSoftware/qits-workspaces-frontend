import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { QitsBadge, QitsButton, type QitsBadgeTone } from '@qits/ui-components';
import type { WorkspaceDto } from '../api/dto';
import type { DaemonReachability } from '../api/workspace-daemon-api';
import { WorkspacesApi } from '../api/workspaces-api';
import type { MergeResult } from '../merge/merge-outcome';
import { MergePanel } from '../merge/merge-panel';
import { driftLabel, relativeSince } from '../ui/format';
import { describeError } from '../ui/loadable';

/** Which button is waiting on the server. Never "some mutation is pending" — one Stop must not spin Start. */
type Pending = 'start' | 'stop' | 'recreate' | 'discard' | null;

/** What the page can say about the in-container daemon right now. */
type DaemonState = 'connected' | 'gone' | 'not-running';

const RUNTIME_TONES: Readonly<Record<string, QitsBadgeTone>> = {
  RUNNING: 'success',
  STOPPED: 'neutral',
  PROVISIONING: 'info',
  FAILED: 'danger',
  QUEUED: 'info',
  UNAVAILABLE: 'warning',
};

/**
 * Everything the detail view knows about the state of its own workspace, plus the verbs that change
 * it.
 *
 * The old screen showed a name and a branch. The *list* showed runtime status, runtime error, daemon
 * connected-since, daemon version, an outdated-daemon warning with its recreate, clean/dirty and
 * ahead/behind — so the page that **is** the workspace was the one place you could not see its
 * state, and it silently assumed you had arrived from the list and remembered. Every field here was
 * already on the wire; the old screen simply ignored them.
 *
 * **The verbs live beside the state they act on**, which is why this is a strip and not a toolbar.
 * Start, Stop and Recreate sit next to the runtime state. The one door home and Discard sit next to
 * the resolution status. The list keeps its verbs too — that is where you act on a workspace you are
 * not inside.
 *
 * **One door, and sometimes none.** Integrate is offered when the work goes home to its parent
 * branch, read from the workspace's parent exactly as the list reads it. Work parented on the
 * repository's default branch gets no button at all: that branch is written by a release request in
 * qits-projects and by nothing here, so the panel says where releasing happens instead. The reading
 * can be stale and the service says so with `RELEASE_REQUIRED` — all of which {@link
 * ../merge/merge-panel#MergePanel} already handles, so this strip hands it the workspace and the
 * default branch and gets out of the way.
 *
 * **Recreate is disabled unless the tree is provably clean.** The service refuses with a 400
 * otherwise, and `clean: null` — what a workspace with no live daemon reports — counts as not clean.
 * That combination is the sharp edge: recreate is the remedy for an outdated daemon, and an outdated
 * daemon is quite often a disconnected one, so the button most likely to be reached for is exactly
 * the one that must explain why it cannot be pressed.
 *
 * **The daemon's connection is a first-class state here, and the live channel's is not.** They are
 * different sizes of problem. A dropped hint channel means the page is briefly behind and will catch
 * up, so it gets a quiet inline marker. A dropped daemon control socket takes the file browser, every
 * terminal and the whole agent surface down with it — the reverse tunnel made that socket
 * load-bearing for the container proxy — and without a sentence here the only symptom is a wall of
 * identical 502s in seven panels.
 *
 * **A runner-placed workspace names its runner and says why it is waiting.** `QUEUED` is a start
 * waiting for a slot — on its own runner, or on any runner when none has taken it yet — and
 * `UNAVAILABLE` is a runner offline beyond its grace. A workspace is sticky to its runner, so the
 * verbs cannot route anywhere else while it is gone: Start, Stop and Recreate are disabled with that
 * sentence rather than offered and answered with a 409.
 *
 * **`UNAVAILABLE` does not mean the session is dead.** The in-container daemon reaches the platform
 * through the edge, not through the runner, so a workspace whose runner has dropped offline can
 * still carry a live `daemonConnectedAt` — and with it `daemonVersion`, `clean` and `agentActivity` —
 * while the lifecycle verbs stay refused. Such a row reads its daemon state exactly as a `RUNNING`
 * one does: connected, or gone if the proxy says so. Only an `UNAVAILABLE` row with no
 * `daemonConnectedAt` has nothing live left to show.
 *
 * **Mutations refresh on settled, not on success.** A failed start still changed something worth
 * re-reading, and the truth after a refusal is more useful than the stale row that produced it.
 */
@Component({
  selector: 'app-status-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MergePanel, QitsBadge, QitsButton],
  templateUrl: './status-strip.html',
  styleUrl: './status-strip.css',
})
export class StatusStrip {
  /** The workspace, as the repository's listing last reported it. */
  readonly workspace = input.required<WorkspaceDto>();

  /** The repository's default branch — what decides whether there is a door. */
  readonly mainBranch = input.required<string>();

  /** What the container proxy last said about the daemon. */
  readonly reachability = input<DaemonReachability>('unknown');

  /** Whether the hint channel is up. False draws the quiet stale-data marker. */
  readonly live = input(true);

  /** Something changed on the server. The page re-reads. */
  readonly changed = output<void>();

  /** A container verb answered with a process id — the Starting tab attaches to it at once. */
  readonly started = output<string>();

  /** The work went home. The page records it, because this workspace is about to leave the list. */
  readonly merged = output<MergeResult>();

  private readonly api = inject(WorkspacesApi);

  protected readonly pending = signal<Pending>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly discarding = signal(false);
  protected readonly discardNote = signal('');

  /**
   * The second confirmation, shown only after a plain discard was refused by the clean-tree guard.
   * Confirming re-sends the discard with `?ignore-changes=true` — the one spelling of "lose the
   * uncommitted changes on purpose", available nowhere but this dialog.
   */
  protected readonly confirmingIgnoreChanges = signal(false);

  protected readonly runtimeTone = computed<QitsBadgeTone>(
    () => RUNTIME_TONES[this.workspace().runtimeStatus ?? ''] ?? 'neutral',
  );

  protected readonly runtimeLabel = computed(
    () => this.workspace().runtimeStatus?.toLowerCase() ?? 'runtime unknown',
  );

  protected readonly running = computed(() => this.workspace().runtimeStatus === 'RUNNING');

  /** The runner this workspace is placed on, by name; null for a DIRECT row and an untaken one. */
  protected readonly runnerName = computed(() =>
    this.workspace().placement === 'RUNNER' ? (this.workspace().runner?.name ?? null) : null,
  );

  /**
   * Where a runner-placed workspace stands and why, as one sentence; null for every DIRECT row, which
   * renders exactly as it always did.
   */
  protected readonly placementNote = computed<string | null>(() => {
    const workspace = this.workspace();
    if (workspace.placement !== 'RUNNER') {
      return null;
    }
    const runner = this.runnerName();
    switch (workspace.runtimeStatus) {
      case 'QUEUED': {
        const since = workspace.queuedAt ? ` since ${relativeSince(workspace.queuedAt)}` : '';
        return runner ? `waiting for a slot on ${runner}${since}` : `waiting for a runner${since}`;
      }
      case 'UNAVAILABLE':
        return this.unavailable();
      default:
        return runner ? `on runner ${runner}` : 'placed on a runner';
    }
  });

  /**
   * Why no verb can be pressed: the owning runner is offline, and the workspace is sticky to it.
   * Null unless the row is `UNAVAILABLE`.
   *
   * **Says more when the session is still up.** A connected daemon means the container itself is
   * reachable through the edge regardless of the runner, so the sentence says that in the same
   * breath rather than leaving a reader to wonder why the file browser still works on a row that
   * calls itself unavailable.
   */
  protected readonly unavailable = computed<string | null>(() => {
    const workspace = this.workspace();
    if (workspace.runtimeStatus !== 'UNAVAILABLE') {
      return null;
    }
    const runner = workspace.runner?.name;
    const base = runner ? `runner ${runner} is offline` : 'its runner is offline';
    return workspace.daemonConnectedAt
      ? `${base} — the session is still up; start, stop and recreate wait for the runner`
      : base;
  });

  protected readonly drift = computed(() => {
    const workspace = this.workspace();
    return driftLabel(workspace.ahead, workspace.behind);
  });

  /**
   * Clean, dirty, or unknown — and unknown is drawn as unknown.
   *
   * qits-workspaces answers null when no live daemon told it, and a null rendered as "clean" would
   * be the strip's one outright lie — on the field that gates the recreate.
   */
  protected readonly cleanliness = computed(() => {
    const clean = this.workspace().clean;
    if (clean === null) {
      return { label: 'working tree unknown', tone: 'neutral' as QitsBadgeTone };
    }
    return clean
      ? { label: 'clean', tone: 'success' as QitsBadgeTone }
      : { label: 'uncommitted changes', tone: 'warning' as QitsBadgeTone };
  });

  protected readonly daemonState = computed<DaemonState>(() => {
    const workspace = this.workspace();
    // UNAVAILABLE with a live daemon reads exactly like RUNNING: the control socket rides the
    // edge, not the runner, so the runner being offline says nothing about whether it is up.
    // UNAVAILABLE with no reported connection is the one case left with nothing live to show.
    const sessionLive =
      workspace.runtimeStatus === 'RUNNING' ||
      (workspace.runtimeStatus === 'UNAVAILABLE' && workspace.daemonConnectedAt !== null);
    if (!sessionLive) {
      return 'not-running';
    }
    if (this.reachability() === 'unreachable' || !workspace.daemonConnectedAt) {
      return 'gone';
    }
    return 'connected';
  });

  protected readonly daemonSince = computed(() => {
    const at = this.workspace().daemonConnectedAt;
    return at ? relativeSince(at) : '';
  });

  /** The recreate guard, as one sentence or null when there is nothing to explain. */
  protected readonly recreateBlocked = computed<string | null>(() => {
    const clean = this.workspace().clean;
    if (clean === true) {
      return null;
    }
    return clean === false
      ? 'Recreate needs a clean working tree — this one has uncommitted changes, and recreating would throw them away.'
      : 'Recreate needs a working tree the service can prove is clean. Nothing is reporting one here, so it is refused rather than risked.';
  });

  protected async start(): Promise<void> {
    await this.run('start', async () => {
      const answer = await this.api.ensureContainer(this.workspace().id);
      if (answer.technicalProcessId) {
        this.started.emit(answer.technicalProcessId);
      }
    });
  }

  protected async stop(): Promise<void> {
    await this.run('stop', () => this.api.stopContainer(this.workspace().id));
  }

  protected async recreate(): Promise<void> {
    await this.run('recreate', async () => {
      const answer = await this.api.recreateContainer(this.workspace().id);
      if (answer.technicalProcessId) {
        this.started.emit(answer.technicalProcessId);
      }
    });
  }

  protected openDiscard(): void {
    this.discarding.set(true);
    this.failure.set(null);
  }

  protected cancelDiscard(): void {
    this.discarding.set(false);
    this.discardNote.set('');
    this.confirmingIgnoreChanges.set(false);
  }

  protected noteTyped(event: Event): void {
    this.discardNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async discard(): Promise<void> {
    // Always plain first: the request that could lose uncommitted work is only ever sent after the
    // service has refused this one and the person has confirmed that exact loss below.
    await this.run('discard', () => this.api.discard(this.workspace().id, this.discardNote()));
    const failure = this.failure();
    if (!failure) {
      this.cancelDiscard();
      return;
    }
    // The clean-tree guard's own words — the same sentence the domain suite asserts, so matching
    // on it is matching the contract, not scraping. Any other failure stays an ordinary failure.
    if (failure.includes('uncommitted changes')) {
      this.failure.set(null);
      this.confirmingIgnoreChanges.set(true);
    }
  }

  protected async discardIgnoringChanges(): Promise<void> {
    await this.run('discard', () =>
      this.api.discard(this.workspace().id, this.discardNote(), true),
    );
    if (!this.failure()) {
      this.cancelDiscard();
    }
  }

  protected cancelIgnoreChanges(): void {
    this.confirmingIgnoreChanges.set(false);
  }

  /**
   * One verb: spin its own button, keep the reason on a failure, and refresh either way.
   *
   * The `finally` is the "settled, not success" rule in three lines — a refused start still moved
   * something, and the row that produced the refusal is the least trustworthy thing on the page.
   */
  private async run(which: Exclude<Pending, null>, call: () => Promise<unknown>): Promise<void> {
    this.pending.set(which);
    this.failure.set(null);
    try {
      await call();
    } catch (error) {
      this.failure.set(describeError(error));
    } finally {
      this.pending.set(null);
      this.changed.emit();
    }
  }
}
