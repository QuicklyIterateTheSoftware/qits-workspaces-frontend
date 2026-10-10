import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import { AgentsApi, barePluginId, type InstalledPluginDto } from '../../api/agents-api';
import { WorkspaceDetection } from '../../api/workspace-detection';
import { Async } from '../../ui/async';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';

/** One plugin this page knows how to offer, and the frameworks it is worth offering for. */
export interface PluginOffer {
  /** The **bare** id — what the install verb takes. The listing reports it marketplace-qualified. */
  readonly pluginId: string;
  readonly name: string;
  readonly summary: string;
  /** Detected framework ids that make this a recommendation. Daemon vocabulary, not ours. */
  readonly frameworks: readonly string[];
}

/**
 * The curated set.
 *
 * **This list is the client's curation and the marketplace is the authority.** The daemon installs by
 * shelling `claude plugin install <id>@claude-plugins-official`, so an id this list gets wrong fails
 * with the marketplace's own words rather than silently doing nothing — which is why the failure copy
 * below quotes the daemon instead of guessing. Anything installed that is *not* on this list is
 * listed anyway, underneath, so the section can never claim less than the volume holds.
 *
 * The framework ids are the daemon's detection vocabulary (`java-quarkus`, `ts-angular`, `ts-lit`,
 * `docs`), not a second spelling invented here.
 */
export const PLUGIN_CATALOGUE: readonly PluginOffer[] = [
  {
    pluginId: 'jdtls-lsp',
    name: 'Java language server',
    summary: 'Eclipse JDT over the agent’s edits — types, references and diagnostics for Java.',
    frameworks: ['java-quarkus'],
  },
  {
    pluginId: 'typescript-lsp',
    name: 'TypeScript language server',
    summary: 'Types and references for TypeScript, which is every frontend in this repository.',
    frameworks: ['ts-angular', 'ts-lit'],
  },
  {
    pluginId: 'pyright-lsp',
    name: 'Python language server',
    summary: 'Pyright, for a checkout with Python in it.',
    frameworks: ['python'],
  },
  {
    pluginId: 'rust-analyzer-lsp',
    name: 'Rust language server',
    summary: 'rust-analyzer, for a Cargo workspace.',
    frameworks: ['rust'],
  },
];

/** One row on screen: an offer, what the volume says about it, and whether it is recommended here. */
interface PluginRow {
  readonly pluginId: string;
  readonly name: string;
  readonly summary: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly recommended: boolean;
}

/**
 * The plugins section: what the shared agent home has, and what this checkout would benefit from.
 *
 * **The store is global to the shared credential volume**, so an install here turns the plugin green
 * in *every* workspace on this platform. The copy says so, because a per-workspace reading of this
 * list would make the next workspace's already-installed chip look like a bug.
 *
 * **Recommendations float, they never filter.** A plugin matching a detected framework goes to the
 * top with a badge and everything else stays visible below it — the detection is a hint about this
 * checkout, not a claim about what is worth installing.
 *
 * The detection itself is **never fetched twice**: it comes from the shared entry the file browser
 * fills, and this section pays for one read only when nothing has read one yet. No detection means no
 * badges and no reordering, which is a plainer screen rather than a broken one.
 */
@Component({
  selector: 'app-plugins-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, QitsBadge, QitsButton],
  template: `
    <app-async
      [state]="state()"
      loadingLabel="Reading the agent's plugins"
      errorLabel="Could not read the plugin store"
      (retry)="reload()"
    />

    @if (state().kind === 'ready') {
      <ul class="plugins">
        @for (row of rows(); track row.pluginId) {
          <li class="plugin">
            <div class="what">
              <span class="name">{{ row.name }}</span>
              @if (row.recommended) {
                <qits-badge tone="info" label="Recommended" />
              }
              @if (row.installed && row.enabled) {
                <qits-badge tone="success" label="Installed" />
              } @else if (row.installed) {
                <qits-badge tone="neutral" label="Installed, switched off" />
              }
              <span class="summary">{{ row.summary }}</span>
            </div>
            @if (!row.installed) {
              <qits-button
                variant="secondary"
                size="sm"
                [busy]="pending() === row.pluginId"
                (pressed)="install(row.pluginId)"
              >
                Install
              </qits-button>
            }
          </li>
        }
      </ul>

      <p class="note">
        The plugin store is the shared agent home, so installing one here turns it on in every
        workspace on this platform. There is no uninstall on this surface.
      </p>

      @if (problem(); as text) {
        <p class="problem" role="alert">
          ⚠ {{ text }} — the agent has to be signed in and its container running for an install to
          work.
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .plugins {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .plugin {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.4rem 0;
    }
    .plugin + .plugin {
      border-top: 1px solid #f3f4f6;
    }
    .what {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      flex: 1;
    }
    .name {
      color: #111827;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .summary {
      color: #6b7280;
      font-size: 0.85rem;
    }
    .note,
    .problem {
      margin: 0.5rem 0 0;
      font-size: 0.8rem;
    }
    .note {
      color: #6b7280;
    }
    .problem {
      color: #b91c1c;
    }
  `,
})
export class PluginsSection {
  private readonly api = inject(AgentsApi);
  private readonly detection = inject(WorkspaceDetection);

  readonly workspaceRowId = input.required<number>();

  /** The agent whose worktree the recommendations are read from. */
  readonly agentId = input.required<string>();

  protected readonly state = signal<Loadable<readonly InstalledPluginDto[]>>(IDLE);
  protected readonly pending = signal<string | null>(null);
  protected readonly problem = signal<string | null>(null);

  private loadedFor = 0;

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      if (workspaceRowId > 0 && workspaceRowId !== this.loadedFor) {
        this.loadedFor = workspaceRowId;
        void this.load(workspaceRowId);
        void this.detection.ensure({ workspaceRowId, agentId: this.agentId() });
      }
    });
  }

  /**
   * The rows: recommended first, then the rest of the catalogue, then anything installed that this
   * page does not know about — which is what keeps the list honest about the volume.
   */
  protected readonly rows = computed<readonly PluginRow[]>(() => {
    const state = this.state();
    const installed = state.kind === 'ready' ? state.value : [];
    const byBareId = new Map(installed.map((entry) => [barePluginId(entry.pluginId), entry]));
    const frameworks = this.detection.frameworkIds();

    const known = PLUGIN_CATALOGUE.map((offer) => {
      const entry = byBareId.get(offer.pluginId);
      return {
        pluginId: offer.pluginId,
        name: offer.name,
        summary: offer.summary,
        installed: entry !== undefined,
        enabled: entry?.enabled ?? false,
        recommended: offer.frameworks.some((framework) => frameworks.has(framework)),
      };
    });
    known.sort((left, right) => Number(right.recommended) - Number(left.recommended));

    const extra = installed
      .filter((entry) => !PLUGIN_CATALOGUE.some((o) => o.pluginId === barePluginId(entry.pluginId)))
      .map((entry) => ({
        pluginId: barePluginId(entry.pluginId),
        name: entry.pluginId,
        summary: 'Installed on the shared agent home, and not one this page curates.',
        installed: true,
        enabled: entry.enabled,
        recommended: false,
      }));

    return [...known, ...extra];
  });

  protected reload(): void {
    void this.load(this.workspaceRowId());
  }

  /**
   * Install one, and take the answer as the new truth.
   *
   * The install route answers the **refreshed installed set** — the same envelope the listing uses,
   * deliberately — so there is no follow-up read here and there must not be one.
   */
  protected async install(pluginId: string): Promise<void> {
    this.pending.set(pluginId);
    this.problem.set(null);
    try {
      this.state.set(ready(await this.api.install(this.workspaceRowId(), pluginId)));
    } catch (error) {
      this.problem.set(describe(error));
    } finally {
      this.pending.set(null);
    }
  }

  private async load(workspaceRowId: number): Promise<void> {
    this.state.set(LOADING);
    try {
      this.state.set(ready(await this.api.plugins(workspaceRowId)));
    } catch (error) {
      this.state.set(failed(error));
    }
  }
}

/** The daemon's own sentence where there is one: it explains a refusal this page cannot. */
function describe(error: unknown): string {
  const body = (error as { error?: { message?: string } } | null)?.error;
  if (body && typeof body.message === 'string' && body.message.trim()) {
    return body.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'The install was refused';
}
