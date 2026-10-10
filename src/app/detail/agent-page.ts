import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, convertToParamMap } from '@angular/router';
import {
  QITS_SCOPE,
  QitsAppLinks,
  QitsBadge,
  QitsButton,
  scopeCommands,
} from '@qits/ui-components';
import { AgentWorktreesApi, type AgentWorktreeDto } from '../api/agent-worktrees-api';
import type { AgentDto, AgentWaitDto } from '../api/dto';
import { WorkspaceAgentsApi } from '../api/workspace-agents-api';
import { WorkspaceDaemonApi } from '../api/workspace-daemon-api';
import { WorkspaceEvents, anyOf } from '../api/workspace-events';
import { Async } from '../ui/async';
import {
  IDLE,
  LOADING,
  describeError,
  failed,
  ready,
  serverMessage,
  type Loadable,
} from '../ui/loadable';
import { agentLabel, workItemLink } from '../ui/work-item';
import { activityLabel, agentStateTone, runStateLabel } from './agent-labels';
import { ChatPanel } from './chat/chat-panel';
import { FilesPanel } from './files/files-panel';
import { TabHost } from './tabs/tab-host';
import { TabPanel } from './tabs/tab-panel';
import { DEFAULT_TAB, DURABLE_TABS, isDurableTab, type TabDef } from './tabs/tabs';
import { TerminalPanel } from './terminal/terminal-panel';

/** How often a queued agent is read again. It has no workspace, so no hint channel tells us. */
export const QUEUED_POLL_MS = 10_000;

/** Where the discard dialog is. */
export type DiscardStep = 'closed' | 'confirm' | 'force';

/** Why a discard was refused, as the service's 409 names it. */
export interface DiscardRefusal {
  readonly code: string | null;
  readonly message: string;
}

/** Read a discard refusal off a 409, or null for any other failure. */
export function discardRefusal(error: unknown): DiscardRefusal | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return null;
  }
  const body = error.error as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : null;
  return { code, message: serverMessage(error.error) ?? 'The service refused the discard.' };
}

/** What a wait reads as: its label, else the event it waits for. */
export function waitLabel(wait: AgentWaitDto): string {
  return wait.label?.trim() || wait.selection?.event?.trim() || 'an event';
}

/**
 * One agent: a work item's coding agent and its worktree (qits-1152, D12).
 *
 * The header says what the agent works on, where it runs and what it is doing; the tabs are Chat,
 * Files and Terminal, each scoped to this agent's worktree. Discard removes the agent.
 *
 * **Reads:** the agent (`GET /workspaces/api/agents/{id}`), its worktree from the workspace daemon
 * (`GET …/container/{rowId}/agent-worktrees/{id}`, for the harness command id and the dirty and
 * unpushed flags), its open waits where the service has them (qits-1153), and its workspace's hint
 * channel. A queued agent has no workspace and so no channel; it is read again every
 * {@link QUEUED_POLL_MS} until it is placed.
 *
 * `/agents/{agentId}?tab=…`: the tab is a query parameter, so a tab switch keeps the page and an
 * agent switch remounts it.
 */
@Component({
  selector: 'app-agent-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Async,
    ChatPanel,
    FilesPanel,
    QitsBadge,
    QitsButton,
    RouterLink,
    TabHost,
    TabPanel,
    TerminalPanel,
  ],
  templateUrl: './agent-page.html',
  styleUrl: './agent-page.css',
})
export class AgentPage {
  private readonly agentsApi = inject(WorkspaceAgentsApi);
  private readonly worktrees = inject(AgentWorktreesApi);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly events = inject(WorkspaceEvents);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly appLinks = inject(QitsAppLinks);

  protected readonly home = computed<string[]>(() => [...scopeCommands(this.qitsScope.scope())]);

  private readonly params = toSignal(this.route.paramMap, { initialValue: convertToParamMap({}) });
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly agentId = computed(() => this.params().get('agentId') ?? '');

  /** One entry, keyed by the agent: a new agent rebuilds every panel under it. */
  protected readonly mountKey = computed(() => [this.agentId()]);

  protected readonly agentState = signal<Loadable<AgentDto>>(LOADING);
  protected readonly worktree = signal<Loadable<AgentWorktreeDto | null>>(IDLE);
  protected readonly waits = signal<readonly AgentWaitDto[]>([]);

  protected readonly discardStep = signal<DiscardStep>('closed');
  protected readonly discarding = signal(false);
  protected readonly refusal = signal<DiscardRefusal | null>(null);
  protected readonly discardProblem = signal<string | null>(null);

  protected readonly live = this.events.connected;
  protected readonly reachability = this.daemon.reachability;

  private readonly agentHints = anyOf(this.events, 'agents', 'agent-activity');
  private readonly worktreeHints = anyOf(this.events, 'agents', 'commands');
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const agentId = this.agentId();
      this.agentHints();
      untracked(() => void this.loadAgent(agentId));
    });

    // The hint channel is the agent's workspace's. Opened once it has one; closed when it loses it.
    effect(() => {
      const rowId = this.workspaceRowId();
      untracked(() => {
        if (rowId > 0) {
          this.events.open(rowId);
        } else {
          this.events.close();
        }
      });
    });

    effect(() => {
      const rowId = this.workspaceRowId();
      const agentId = this.agentId();
      this.worktreeHints();
      untracked(() => void this.loadWorktree(rowId, agentId));
    });

    effect(() => {
      const agentId = this.agentId();
      this.agentHints();
      untracked(() => void this.loadWaits(agentId));
    });

    effect(() => {
      const queued = this.queued();
      untracked(() => this.pollWhile(queued));
    });

    effect(() => {
      this.agentId();
      untracked(() => {
        this.discardStep.set('closed');
        this.refusal.set(null);
        this.discardProblem.set(null);
        this.daemon.resetReachability();
      });
    });

    // An unknown tab slug is dropped from the URL rather than obeyed.
    effect(() => {
      const slug = this.query().get('tab');
      if (slug !== null && !isDurableTab(slug)) {
        untracked(() =>
          this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { tab: null },
            queryParamsHandling: 'merge',
            replaceUrl: true,
          }),
        );
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.events.close();
      this.daemon.resetReachability();
      this.pollWhile(false);
    });
  }

  // ---- what is on screen ----------------------------------------------------------------------

  protected readonly agent = computed<AgentDto | null>(() => {
    const state = this.agentState();
    return state.kind === 'ready' && state.value.agentId === this.agentId() ? state.value : null;
  });

  protected readonly workspaceRowId = computed(() => this.agent()?.workspaceRowId ?? 0);

  private readonly queued = computed(() => {
    const agent = this.agent();
    return agent !== null && agent.state !== 'REMOVED' && this.workspaceRowId() <= 0;
  });

  protected readonly removed = computed(() => this.agent()?.state === 'REMOVED');

  protected readonly label = computed(() => {
    const agent = this.agent();
    return agent ? agentLabel(agent) : 'Agent';
  });

  protected readonly runState = computed(() => {
    const agent = this.agent();
    return agent ? runStateLabel(agent) : '';
  });

  protected readonly activity = computed(() => activityLabel(this.agent()?.activity ?? null));

  protected readonly stateTone = computed(() => agentStateTone(this.agent()?.state ?? 'REMOVED'));

  protected readonly workItemHref = computed(() => {
    const agent = this.agent();
    const link = agent ? workItemLink(agent) : null;
    return link
      ? this.appLinks.href('qits-projects', link.path, { project: link.project })
      : undefined;
  });

  protected readonly workspaceRoute = computed<readonly unknown[] | null>(() => {
    const agent = this.agent();
    if (!agent || !agent.workspaceRowId) {
      return null;
    }
    return [...this.home(), 'repositories', agent.repositoryId, 'workspaces', agent.workspaceRowId];
  });

  protected readonly worktreeValue = computed<AgentWorktreeDto | null>(() => {
    const state = this.worktree();
    return state.kind === 'ready' ? state.value : null;
  });

  protected readonly commandId = computed(() => this.worktreeValue()?.commandId ?? null);

  protected readonly waitLabels = computed(() => this.waits().map(waitLabel));

  /** What the work is about, for the prompt rewrite: the item's id and title. */
  protected readonly preamble = computed(() => {
    const agent = this.agent();
    if (!agent) {
      return null;
    }
    return [agentLabel(agent), agent.entityTitle].filter(Boolean).join(': ') || null;
  });

  protected readonly urlTab = computed(() => {
    const slug = this.query().get('tab');
    return isDurableTab(slug) ? slug! : DEFAULT_TAB;
  });

  /** The tab row, with a dot on Chat while the agent works or waits on you. */
  protected readonly tabs = computed<readonly TabDef[]>(() => {
    const activity = this.agent()?.activity ?? null;
    return DURABLE_TABS.map((tab) => {
      if (tab.slug !== 'chat' || (activity !== 'BUSY' && activity !== 'WAITING')) {
        return tab;
      }
      return activity === 'BUSY'
        ? { ...tab, dot: 'accent' as const, dotTitle: 'The agent is working' }
        : { ...tab, dot: 'warning' as const, dotTitle: 'The agent waits on you' };
    });
  });

  protected readonly durableTabs = DURABLE_TABS;

  // ---- reads ----------------------------------------------------------------------------------

  protected async loadAgent(agentId: string): Promise<void> {
    if (!agentId) {
      return;
    }
    try {
      const agent = await this.agentsApi.agent(agentId);
      if (this.agentId() === agentId) {
        this.agentState.set(ready(agent));
      }
    } catch (error) {
      if (this.agentId() === agentId) {
        this.agentState.set(failed(error));
      }
    }
  }

  /** The daemon's view of the worktree. A 404 is "no worktree yet", not an error. */
  private async loadWorktree(rowId: number, agentId: string): Promise<void> {
    if (rowId <= 0 || !agentId) {
      this.worktree.set(IDLE);
      return;
    }
    try {
      const worktree = await this.worktrees.worktree(rowId, agentId);
      if (this.agentId() === agentId) {
        this.worktree.set(ready(worktree));
      }
    } catch (error) {
      if (this.agentId() !== agentId) {
        return;
      }
      this.worktree.set(
        error instanceof HttpErrorResponse && error.status === 404 ? ready(null) : failed(error),
      );
    }
  }

  /** Open waits are shown when the service has them, and never block the page. */
  private async loadWaits(agentId: string): Promise<void> {
    if (!agentId) {
      return;
    }
    try {
      const waits = await this.agentsApi.openWaits(agentId);
      if (this.agentId() === agentId) {
        this.waits.set(waits);
      }
    } catch {
      // Waits are an extra; a failed read leaves what was shown.
    }
  }

  protected reload(): void {
    void this.loadAgent(this.agentId());
  }

  // ---- what the page does ---------------------------------------------------------------------

  protected chooseTab(slug: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: slug },
      queryParamsHandling: 'merge',
    });
  }

  protected openDiscard(): void {
    this.discardStep.set('confirm');
    this.refusal.set(null);
    this.discardProblem.set(null);
  }

  protected cancelDiscard(): void {
    this.discardStep.set('closed');
    this.refusal.set(null);
    this.discardProblem.set(null);
  }

  /**
   * Discard: plain first. Only after the service refused for leftover work or an unreachable daemon,
   * and the person confirmed that loss, is `force` sent.
   */
  protected async discard(force = false): Promise<void> {
    const agent = this.agent();
    if (!agent || this.discarding()) {
      return;
    }
    this.discarding.set(true);
    this.discardProblem.set(null);
    try {
      await this.agentsApi.discard(agent.agentId, force);
      this.discardStep.set('closed');
      const workspace = this.workspaceRoute();
      await this.router.navigate(workspace ? [...workspace] : this.home());
    } catch (error) {
      const refusal = force ? null : discardRefusal(error);
      if (refusal) {
        this.refusal.set(refusal);
        this.discardStep.set('force');
      } else {
        this.discardProblem.set(`The agent was not discarded — ${describeError(error)}.`);
      }
    } finally {
      this.discarding.set(false);
    }
  }

  private pollWhile(queued: boolean): void {
    if (queued && !this.poll) {
      this.poll = setInterval(() => void this.loadAgent(this.agentId()), QUEUED_POLL_MS);
    } else if (!queued && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}
