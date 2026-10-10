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
import { relativeSince } from '../ui/format';
import { describeError } from '../ui/loadable';

/** Which button is waiting on the server. Never "some mutation is pending" — one Stop must not spin Start. */
type Pending = 'start' | 'stop' | 'recreate' | null;

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
 * A workspace's container and daemon, and the verbs that change them: Start, Stop and Recreate.
 *
 * A workspace is a slot that hosts agents (qits-1152), so there is no branch, working tree or door
 * home here any more: those belong to each agent. Nothing discards a slot by hand either; the service
 * removes it once its last agent is gone.
 *
 * **Recreate is disabled unless the tree is provably clean.** The service refuses with a 400
 * otherwise, and `clean: null` — what a workspace with no live daemon reports — counts as not clean.
 *
 * **A missing daemon is one sentence, not seven 502s.** The container proxy runs over the daemon's
 * control socket, so a blip there takes files, terminals and the agent surface down together.
 */
@Component({
  selector: 'app-status-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsBadge, QitsButton],
  templateUrl: './status-strip.html',
  styleUrl: './status-strip.css',
})
export class StatusStrip {
  /** The workspace, as the repository's listing last reported it. */
  readonly workspace = input.required<WorkspaceDto>();

  /** What the container proxy last said about the daemon. */
  readonly reachability = input<DaemonReachability>('unknown');

  /** Whether the hint channel is up. False draws the quiet stale-data marker. */
  readonly live = input(true);

  /** Something changed on the server. The page re-reads. */
  readonly changed = output<void>();

  /** A container verb answered with a process id — the Starting tab attaches to it at once. */
  readonly started = output<string>();

  private readonly api = inject(WorkspacesApi);

  protected readonly pending = signal<Pending>(null);
  protected readonly failure = signal<string | null>(null);

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
