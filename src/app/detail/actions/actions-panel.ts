import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { QitsBadgeTone } from '@qits/ui-components';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import type {
  ActionDto,
  CommandDto,
  CommandLogLineDto,
  CommandStatus,
} from '../../api/commands-api';
import { CommandsApi } from '../../api/commands-api';
import type { WorkspaceRuntimeStatus } from '../../api/dto';
import { WorkspaceCommands } from '../../api/workspace-commands';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';
import { BootstrapSection } from './bootstrap-section';

/** The statuses that mean the container is not answering, as opposed to answering "no". */
const UNREACHABLE: readonly number[] = [0, 502, 503, 504];

/**
 * The Actions tab: what this checkout declares, what has run, and the bootstrap chain.
 *
 * ## What it loads
 *
 * **On first open this panel reads `4`**, three of its own plus one shared:
 *
 * 1. `GET /commands/actions` — the declared actions.
 * 2. `GET /bootstrap-commands` — the declared chain, in the section below.
 * 3. `GET /workspaces/api/workspaces/{id}/bootstrap-runs` — its per-step last run, host-side.
 * 4. `GET /commands` — the shared command list, which is the run history. **Free whenever anything
 *    else has already read it**, which on a normal page open means Chat has: it is one entry, owned
 *    in one place, and four surfaces share it precisely so that four readers cost one request.
 *
 * A command's log is read on demand, when a row is expanded, and never on load.
 *
 * ## The run history dies with the container, and the panel says so
 *
 * The list comes from the daemon's in-memory store, per container. **There is no host-side
 * fallback**: `WorkspaceCommandHistory` is an unbound port — injected as `Instance<T>` and always
 * absent — so `history/{id}.commands` is `[]` for every workspace, active or resolved. The host has
 * no command history at all, and binding that port is a feature with its own plan rather than
 * something to smuggle in behind this panel.
 *
 * So a stopped container has no run history to show, and the difference between *that* and "nothing
 * has ever run here" is the whole point: one is a gap in what can be known, the other is a fact
 * about the workspace. An empty list would say the second when the first is true. It is rendered as
 * an explicit state instead, and a recreate is named as what clears it — because it does, and
 * knowing that in advance is better than discovering it.
 */
@Component({
  selector: 'app-actions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, BootstrapSection, Empty, QitsBadge, QitsButton],
  templateUrl: './actions-panel.html',
  styleUrl: './actions-panel.css',
})
export class ActionsPanel {
  private readonly api = inject(CommandsApi);
  private readonly entry = inject(WorkspaceCommands);

  /** Which workspace's container to read. The row id, which is what the proxy addresses. */
  readonly workspaceRowId = input.required<number>();

  /** Whether this tab is showing. Gates the action list and the bootstrap section. */
  readonly visible = input(false);

  /** Read to name the container-stopped state before a request fails rather than after. */
  readonly runtimeStatus = input<WorkspaceRuntimeStatus | null>(null);

  /**
   * Whether the row's own `daemonConnectedAt` is set — the session-is-up fact, read only for
   * `UNAVAILABLE`. A runner-placed workspace whose runner has dropped offline still runs its
   * control socket through the edge, so a connected daemon there is not a gone container.
   */
  readonly daemonConnected = input(false);

  protected readonly actions = signal<Loadable<readonly ActionDto[]>>(IDLE);

  /** Rows with a run or a terminate in flight, keyed so one press spins one row. */
  protected readonly pending = signal<ReadonlySet<string>>(new Set<string>());

  /** Per-command log, fetched only when a row is opened. */
  protected readonly logs = signal<ReadonlyMap<string, Loadable<readonly CommandLogLineDto[]>>>(
    new Map(),
  );

  private readonly commandHints = this.entry.commands;

  private loadedFor: number | null = null;

  constructor() {
    // The shared entry is idempotent for the same id and owns its own freshness, so this is the
    // whole of the run history's wiring.
    effect(() => this.entry.use(this.workspaceRowId()));

    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const visible = this.visible();
      untracked(() => {
        if (visible && workspaceRowId > 0 && this.loadedFor !== workspaceRowId) {
          this.loadedFor = workspaceRowId;
          void this.loadActions(workspaceRowId);
        }
      });
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  protected readonly history = computed(() => this.commandHints());

  protected readonly actionRows = computed<readonly ActionDto[]>(() => {
    const state = this.actions();
    return state.kind === 'ready' ? state.value : [];
  });

  protected readonly historyRows = computed<readonly CommandDto[]>(() => {
    const state = this.history();
    return state.kind === 'ready' ? state.value : [];
  });

  /**
   * The container is not there.
   *
   * Either the workspace row already says so, or the proxy answered that nothing is listening. Both
   * are the same sentence to a reader, and the row is checked first because it is knowable without a
   * failed request.
   *
   * **`UNAVAILABLE` with a connected daemon is the one exception.** The runner being offline does
   * not take the control socket down with it — that rides the edge — so a row reporting
   * `daemonConnectedAt` is not gone even though its runtime status says otherwise. The
   * proxy-unreachable fallback below still applies on top of that: a stale "connected" row whose
   * proxy has just started failing is caught the same way it always was.
   */
  protected readonly containerGone = computed(() => {
    const runtime = this.runtimeStatus();
    const sessionLive =
      runtime === 'RUNNING' || (runtime === 'UNAVAILABLE' && this.daemonConnected());
    if (runtime !== null && !sessionLive) {
      return true;
    }
    const state = this.actions();
    return state.kind === 'error' && UNREACHABLE.includes(state.status);
  });

  /**
   * Whether the run history is unavailable rather than empty.
   *
   * The container being gone is enough on its own: the store is in the container, so there is
   * nothing to read even if the list on hand is a stale `ready` from before it stopped.
   */
  protected readonly historyUnavailable = computed(() => {
    if (this.containerGone()) {
      return true;
    }
    const state = this.history();
    return state.kind === 'error' && UNREACHABLE.includes(state.status);
  });

  /** Suppressed where the panel's own sentence is the better account of the same failure. */
  protected readonly actionsProblem = computed(() => {
    const state = this.actions();
    return state.kind === 'error' && this.containerGone() ? IDLE : state;
  });

  protected readonly historyProblem = computed(() => {
    const state = this.history();
    return state.kind === 'error' && this.historyUnavailable() ? IDLE : state;
  });

  protected statusTone(status: CommandStatus): QitsBadgeTone {
    switch (status) {
      case 'RUNNING':
        return 'info';
      case 'EXITED':
        return 'success';
      default:
        return 'warning';
    }
  }

  /** A command whose exit code is not zero failed, whatever its status says about how it stopped. */
  protected exitTone(command: CommandDto): QitsBadgeTone {
    return command.exitCode === 0 ? 'success' : 'danger';
  }

  /** A kind badge for anything that is not a plain terminal run — the history shows everything. */
  protected kindBadge(command: CommandDto): string | null {
    return command.kind === 'TERMINAL' ? null : command.kind.toLowerCase();
  }

  protected isPending(id: string): boolean {
    return this.pending().has(id);
  }

  protected logOf(commandId: string): Loadable<readonly CommandLogLineDto[]> | null {
    return this.logs().get(commandId) ?? null;
  }

  protected isOpen(commandId: string): boolean {
    return this.logs().has(commandId);
  }

  // ---- what the panel does -----------------------------------------------------------------

  /**
   * Run a declared action.
   *
   * **Spawn-and-return, always.** There is no fire-and-await form on this API — the triple that
   * carries an exit code and captured output back inline exists only on the control socket — so an
   * action reports through the run history below like any other command, and there is no inline
   * result panel to build.
   *
   * The list is refreshed **when the call settles**, not when it succeeds: a launch that was refused
   * has changed nothing, and a launch whose answer was lost has changed everything, and refetching
   * the truth is the only way to tell those apart.
   */
  protected async run(action: ActionDto): Promise<void> {
    this.pending.update((pending) => new Set(pending).add(action.id));
    try {
      await this.api.runAction(this.workspaceRowId(), action.id);
    } catch {
      // The refreshed history is the report. A second error line would say the same thing worse.
    } finally {
      this.pending.update((pending) => {
        const next = new Set(pending);
        next.delete(action.id);
        return next;
      });
      await this.entry.refresh();
    }
  }

  /**
   * Signal a running command's process group.
   *
   * Distinct from closing a socket, which only detaches and leaves the process running — that
   * distinction is what makes a tab switch free everywhere else on this page.
   */
  protected async terminate(command: CommandDto): Promise<void> {
    this.pending.update((pending) => new Set(pending).add(command.id));
    try {
      await this.api.terminate(this.workspaceRowId(), command.id);
    } catch {
      // Same reasoning as a refused run: the refetch below is the report.
    } finally {
      this.pending.update((pending) => {
        const next = new Set(pending);
        next.delete(command.id);
        return next;
      });
      await this.entry.refresh();
    }
  }

  /** Expand or collapse a finished row's captured output, reading it the first time it is opened. */
  protected async toggleLog(command: CommandDto): Promise<void> {
    const commandId = command.id;
    if (this.logs().has(commandId)) {
      this.logs.update((logs) => {
        const next = new Map(logs);
        next.delete(commandId);
        return next;
      });
      return;
    }
    this.setLog(commandId, LOADING);
    try {
      this.setLog(commandId, ready(await this.api.log(this.workspaceRowId(), commandId)));
    } catch (error) {
      this.setLog(commandId, failed(error));
    }
  }

  protected reloadActions(): void {
    void this.loadActions(this.workspaceRowId());
  }

  protected reloadHistory(): void {
    void this.entry.refresh();
  }

  // ---- reads -------------------------------------------------------------------------------

  private setLog(commandId: string, state: Loadable<readonly CommandLogLineDto[]>): void {
    this.logs.update((logs) => new Map(logs).set(commandId, state));
  }

  private async loadActions(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    this.actions.set(LOADING);
    try {
      const actions = await this.api.actions(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.actions.set(ready(actions));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.actions.set(failed(error));
      }
    }
  }
}
