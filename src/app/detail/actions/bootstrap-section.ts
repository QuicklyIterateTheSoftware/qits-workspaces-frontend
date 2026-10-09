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
import { QitsBadge, QitsButton, type QitsBadgeTone } from '@qits/ui-components';
import { BootstrapApi, type BootstrapStepDto } from '../../api/bootstrap-api';
import type { BootstrapOutcome, BootstrapRunDto, WorkspaceRuntimeStatus } from '../../api/dto';
import { WorkspaceEvents } from '../../api/workspace-events';
import { WorkspacesApi } from '../../api/workspaces-api';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';

/** One step of the chain, with whatever the host remembers about its last run here. */
export interface BootstrapRow {
  readonly step: BootstrapStepDto;
  readonly key: string;
  readonly run: BootstrapRunDto | null;
}

/**
 * Join a declared chain to a workspace's run rows.
 *
 * **The join key is `id ?? name`.** The daemon defaults a step's `id` to its `name` and omits the
 * key only when the declaration carries neither, and the host writes that same value into
 * `bootstrapCommandId` — which is exactly why the id is on the run row and not only the display
 * name. Matching on the name alone would break for any step that declares an id, and matching on the
 * id alone would break for any step that does not.
 *
 * Exported so the rule is asserted directly rather than through a rendered row: it is the one place
 * two services' vocabularies have to agree, and it is the place a future rename will land.
 */
export function joinChain(
  steps: readonly BootstrapStepDto[],
  runs: readonly BootstrapRunDto[],
): readonly BootstrapRow[] {
  const byId = new Map(runs.map((run) => [run.bootstrapCommandId, run] as const));
  return steps.map((step) => {
    const key = step.id ?? step.name;
    return { step, key, run: byId.get(key) ?? null };
  });
}

/**
 * The Bootstrap section, inside Actions.
 *
 * It is a section and not a tab deliberately: the chain is a *repository-level* declaration whose
 * only per-workspace content is when each step last ran here, which is three lines of status.
 *
 * ## What it loads
 *
 * **On first open this section reads `2`** — `GET /bootstrap-commands` on the daemon for the
 * declared chain, and `GET /workspaces/api/workspaces/{id}/bootstrap-runs` on the host for the last
 * run of each step. Two services because the two halves belong to two owners: the declaration is in
 * the container and dies with it, and the history is a host table precisely so it does not.
 *
 * ## Why there is no "chain running" state
 *
 * There is none to read. A run is a `202` and its progress rides the daemon's **control socket** as
 * `BootstrapStep`/`BootstrapOutcome`/`Bootstrapped` frames — a channel no browser can attach to.
 * There is no HTTP surface anywhere that answers "is the chain running".
 *
 * So this section shows what it actually knows: a press is acknowledged as *requested*, and that
 * acknowledgement clears when a `bootstrap` hint arrives and the run rows are re-read. It does not
 * grey the whole section out on a guess about a run it cannot see, and it does not spin forever
 * waiting for a completion signal that will never reach it. The sentence under the header says which
 * of those two things is happening, because a user watching a button that will not resolve deserves
 * to know it is the architecture and not a hang.
 */
@Component({
  selector: 'app-bootstrap-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton],
  template: `
    <header class="head">
      <h3>Bootstrap</h3>
      <qits-button
        variant="secondary"
        size="sm"
        [busy]="requested().has(ALL)"
        [disabled]="containerGone() || requested().size > 0"
        (pressed)="runAll()"
        >Run all</qits-button
      >
    </header>

    @if (containerGone()) {
      <p class="gone" role="status">
        The container is stopped — the chain is declared in the container, so it cannot be listed or
        run from here. The last-run rows below are held by the platform and survive the container.
      </p>
    }

    <app-async
      [state]="chainProblem()"
      loadingLabel="Loading the bootstrap chain"
      errorLabel="Could not load the bootstrap chain"
      (retry)="reloadChain()"
    />
    <app-async
      [state]="runs()"
      loadingLabel="Loading the bootstrap history"
      errorLabel="Could not load the bootstrap history"
      (retry)="reloadRuns()"
    />

    @if (rows().length > 0) {
      <ol class="steps">
        @for (row of rows(); track row.key) {
          <li class="step">
            <div class="ident">
              <span class="name">{{ row.step.name }}</span>
              @if (row.step.description) {
                <span class="desc">{{ row.step.description }}</span>
              }
            </div>

            <div class="last">
              @if (row.run; as run) {
                <qits-badge [label]="outcomeLabel(run.outcome)" [tone]="outcomeTone(run.outcome)" />
                <time [attr.datetime]="run.ranAt">{{ run.ranAt }}</time>
                @if (run.exitCode !== null && run.exitCode !== 0) {
                  <span class="exit">exit {{ run.exitCode }}</span>
                }
                @if (run.outcome === 'SKIPPED') {
                  <span class="note">its check said it was not needed, so nothing ran</span>
                }
              } @else {
                <span class="never">never ran in this workspace</span>
              }
            </div>

            <div class="verbs">
              <qits-button
                variant="ghost"
                size="sm"
                [busy]="requested().has(row.step.name)"
                [disabled]="containerGone() || requested().size > 0"
                (pressed)="runStep(row.step.name)"
                >Run</qits-button
              >
            </div>
          </li>
        }
      </ol>
    } @else if (chain().kind === 'ready' && !containerGone()) {
      <app-empty message="This checkout declares no bootstrap chain." />
    }

    @if (orphans().length > 0) {
      <p class="orphans">
        {{ orphans().length }}
        {{ orphans().length === 1 ? 'recorded run has' : 'recorded runs have' }} no matching step in
        the chain the container declares — {{ orphans().join(', ') }}. The declaration has moved on
        since {{ orphans().length === 1 ? 'it' : 'they' }} ran; the row is kept rather than dropped,
        because it is the record that something happened here.
      </p>
    }

    @if (requested().size > 0) {
      <p class="requested" role="status">
        Requested. The chain reports its progress on the daemon’s control socket, which this page
        cannot attach to — the rows above update when the platform records an outcome, and that is
        the first thing a browser can see.
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
      margin-top: 1.25rem;
      padding-top: 0.85rem;
      border-top: 1px solid #e5e7eb;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    h3 {
      margin: 0;
      flex: 1 1 auto;
      font-size: 0.95rem;
    }
    .steps {
      margin: 0.35rem 0 0;
      padding: 0 0 0 1.4rem;
    }
    .step {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      padding: 0.45rem 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .ident {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      flex: 1 1 12rem;
      min-width: 0;
    }
    .name {
      font-size: 0.88rem;
      font-weight: 600;
    }
    .desc {
      color: #6b7280;
      font-size: 0.8rem;
    }
    .last {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex: 0 0 auto;
      flex-wrap: wrap;
      color: #6b7280;
      font-size: 0.8rem;
    }
    .exit {
      color: #b91c1c;
    }
    .never {
      font-style: italic;
    }
    .verbs {
      flex: 0 0 auto;
    }
    .gone,
    .orphans {
      margin: 0.35rem 0;
      color: #b45309;
      font-size: 0.8rem;
    }
    .requested,
    .note {
      color: #6b7280;
      font-size: 0.78rem;
    }
    .requested {
      margin: 0.5rem 0 0;
    }
  `,
})
export class BootstrapSection {
  private readonly api = inject(BootstrapApi);
  private readonly host = inject(WorkspacesApi);
  private readonly hintSource = inject(WorkspaceEvents);

  /** The sentinel the "Run all" button holds while its request is in flight. */
  protected readonly ALL = ' all';

  readonly workspaceRowId = input.required<number>();

  /** Whether the Actions tab is showing. Both reads gate on it and catch up on return. */
  readonly visible = input(false);

  /** Read to say *why* the chain is unavailable before the request fails. */
  readonly runtimeStatus = input<WorkspaceRuntimeStatus | null>(null);

  /**
   * Whether the row's own `daemonConnectedAt` is set — read only for `UNAVAILABLE`, where a
   * runner being offline does not take the daemon's control socket down with it.
   */
  readonly daemonConnected = input(false);

  protected readonly chain = signal<Loadable<readonly BootstrapStepDto[]>>(IDLE);
  protected readonly runs = signal<Loadable<readonly BootstrapRunDto[]>>(IDLE);

  /** Which step names have a run request in flight, plus {@link ALL} for the whole chain. */
  protected readonly requested = signal<ReadonlySet<string>>(new Set<string>());

  private readonly hints = this.hintSource.invalidations('bootstrap');

  private loadedFor: number | null = null;
  private seenHint = -1;
  private missedHint = false;

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const hint = this.hints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, hint, visible));
    });

    // An outcome the platform recorded is the only completion signal a browser gets, so it is what
    // clears the acknowledgement. Anything else would be a timer pretending to know.
    effect(() => {
      this.hints();
      untracked(() => this.requested.set(new Set<string>()));
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  protected readonly containerGone = computed(() => {
    const runtime = this.runtimeStatus();
    // UNAVAILABLE with a connected daemon still has a reachable control socket — the runner being
    // offline is what blocks the lifecycle verbs, not the chain the daemon can run regardless.
    const sessionLive =
      runtime === 'RUNNING' || (runtime === 'UNAVAILABLE' && this.daemonConnected());
    if (runtime !== null && !sessionLive) {
      return true;
    }
    const state = this.chain();
    return state.kind === 'error' && [0, 502, 503, 504].includes(state.status);
  });

  /** The chain's own failure banner, suppressed for the one case the sentence above explains better. */
  protected readonly chainProblem = computed(() => {
    const state = this.chain();
    return state.kind === 'error' && this.containerGone() ? IDLE : state;
  });

  protected readonly rows = computed<readonly BootstrapRow[]>(() => {
    const chain = this.chain();
    const runs = this.runs();
    if (chain.kind !== 'ready') {
      return [];
    }
    return joinChain(chain.value, runs.kind === 'ready' ? runs.value : []);
  });

  /**
   * Runs the declared chain no longer accounts for.
   *
   * Named rather than hidden: the chain is a checkout's committed file and a step can be renamed or
   * removed between one run and the next, so a run row with nowhere to go is ordinary rather than
   * corrupt — and silently discarding it would erase the only record that the step ever ran here.
   */
  protected readonly orphans = computed<readonly string[]>(() => {
    const runs = this.runs();
    const chain = this.chain();
    if (runs.kind !== 'ready' || chain.kind !== 'ready') {
      return [];
    }
    const declared = new Set(chain.value.map((step) => step.id ?? step.name));
    return runs.value
      .filter((run) => !declared.has(run.bootstrapCommandId))
      .map((run) => run.commandName);
  });

  protected outcomeTone(outcome: BootstrapOutcome): QitsBadgeTone {
    switch (outcome) {
      case 'SUCCEEDED':
        return 'success';
      case 'FAILED':
        return 'danger';
      default:
        return 'neutral';
    }
  }

  protected outcomeLabel(outcome: BootstrapOutcome): string {
    return outcome.toLowerCase();
  }

  // ---- what the section does ---------------------------------------------------------------

  protected async runAll(): Promise<void> {
    await this.request(this.ALL, () => this.api.runChain(this.workspaceRowId()));
  }

  protected async runStep(name: string): Promise<void> {
    await this.request(name, () => this.api.runStep(this.workspaceRowId(), name));
  }

  /**
   * Send a run and hold the acknowledgement.
   *
   * The flag is *not* cleared when the request settles: a `202` means the daemon took the job, and
   * the job is what the user is waiting on. It clears on the next `bootstrap` hint — the platform
   * recording an outcome — or on a failure to hand the job over at all, which is the one case where
   * nothing is running and pretending otherwise would strand the button.
   */
  private async request(key: string, send: () => Promise<void>): Promise<void> {
    this.requested.update((requested) => new Set(requested).add(key));
    try {
      await send();
    } catch {
      this.requested.update((requested) => {
        const next = new Set(requested);
        next.delete(key);
        return next;
      });
      return;
    }
    await this.loadRuns(this.workspaceRowId());
  }

  protected reloadChain(): void {
    void this.loadChain(this.workspaceRowId());
  }

  protected reloadRuns(): void {
    void this.loadRuns(this.workspaceRowId());
  }

  // ---- reads -------------------------------------------------------------------------------

  private decideRead(workspaceRowId: number, hint: number, visible: boolean): void {
    if (workspaceRowId <= 0) {
      return;
    }
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    if (!visible) {
      return;
    }
    if (this.loadedFor === workspaceRowId && !this.missedHint) {
      return;
    }
    this.missedHint = false;
    this.loadedFor = workspaceRowId;
    void this.loadChain(workspaceRowId);
    void this.loadRuns(workspaceRowId);
  }

  private async loadChain(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    this.chain.set(LOADING);
    try {
      const chain = await this.api.chain(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.chain.set(ready(chain));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.chain.set(failed(error));
      }
    }
  }

  private async loadRuns(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    this.runs.set(LOADING);
    try {
      const runs = await this.host.bootstrapRuns(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.runs.set(ready(runs));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.runs.set(failed(error));
      }
    }
  }
}
