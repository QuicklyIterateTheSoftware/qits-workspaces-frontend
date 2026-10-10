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
import { QITS_SCOPE, QitsAppLinks, QitsBadge, scopeCommands } from '@qits/ui-components';
import type {
  AgentDto,
  RepositoryDto,
  WorkspaceAgentSessionDto,
  WorkspaceDto,
  WorkspaceHistoryDetailDto,
} from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspaceAgentsApi } from '../api/workspace-agents-api';
import { WorkspaceDaemonApi } from '../api/workspace-daemon-api';
import { WorkspaceEvents, anyOf } from '../api/workspace-events';
import { WorkspacesApi } from '../api/workspaces-api';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { NONE } from '../ui/format';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { agentLabel, workItemLink } from '../ui/work-item';
import { activityLabel, agentStateTone, runStateLabel } from './agent-labels';
import { EMPTY_CONVERSATION, buildConversation } from './chat/chat-model';
import { Conversation } from './chat/conversation';
import { StartingPanel } from './starting/starting-panel';
import { StatusStrip } from './status-strip';

/** How long the Starting section stays after its process finishes, so its last line can be read. */
export const LINGER_MS = 5000;

/**
 * One workspace: a slot on a runner that hosts agents (qits-1152, D12).
 *
 * It shows the slot — runner, placement, container and daemon, admin — and the agents it hosts, each
 * a link to its own page with Chat, Files and Terminal. Nothing here is per agent.
 *
 * **Reads:** the workspace (`GET /workspaces/api/workspaces/{id}`), its agents (`GET
 * /workspaces/api/agents?workspaceId=`), the repository for its name, the active technical process,
 * and one hint channel (`…/workspaces/{id}/events`). Nothing polls: a hint re-reads what it names.
 *
 * A 404 on the workspace means it has resolved (or never existed); its history record and archived
 * agent sessions are what is left to show.
 *
 * The route keeps its repository segment (`repositories/{repositoryId}/workspaces/{id}`) so old links
 * still land; the page reads the workspace by its own id.
 */
@Component({
  selector: 'app-workspace-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Conversation, Empty, QitsBadge, RouterLink, StartingPanel, StatusStrip],
  templateUrl: './workspace-detail-page.html',
  styleUrl: './workspace-detail-page.css',
})
export class WorkspaceDetailPage {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly agentsApi = inject(WorkspaceAgentsApi);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly events = inject(WorkspaceEvents);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly appLinks = inject(QitsAppLinks);

  /** Where this page's own links start: bare, or under the scope the reader came in through. */
  protected readonly home = computed<string[]>(() => [...scopeCommands(this.qitsScope.scope())]);

  private readonly params = toSignal(this.route.paramMap, { initialValue: convertToParamMap({}) });
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly repositoryId = computed(() => this.params().get('repositoryId') ?? '');
  protected readonly workspaceId = computed(() => Number(this.params().get('workspaceId') ?? 0));

  protected readonly repository = signal<Loadable<RepositoryDto>>(IDLE);
  protected readonly workspaceState = signal<Loadable<WorkspaceDto>>(LOADING);
  protected readonly agents = signal<Loadable<readonly AgentDto[]>>(IDLE);
  protected readonly history = signal<Loadable<WorkspaceHistoryDetailDto>>(IDLE);
  protected readonly sessions = signal<Loadable<readonly WorkspaceAgentSessionDto[]>>(IDLE);
  protected readonly transcript = signal<Loadable<readonly string[]>>(IDLE);

  /** The process the Starting section shows; it outlives the process by {@link LINGER_MS}. */
  protected readonly shownProcessId = signal<string | null>(null);
  private linger: ReturnType<typeof setTimeout> | null = null;

  protected readonly none = NONE;
  protected readonly reachability = this.daemon.reachability;
  protected readonly live = this.events.connected;

  private readonly workspaceHints = anyOf(this.events, 'agent-activity', 'process', 'agents');
  private readonly agentHints = anyOf(this.events, 'agents', 'agent-activity');
  private readonly processHints = this.events.invalidations('process');

  private readingSession: string | null = null;
  private loadedRepositoryId: string | null = null;

  constructor() {
    effect(() => {
      const repositoryId = this.repositoryId();
      if (repositoryId !== this.loadedRepositoryId) {
        this.loadedRepositoryId = repositoryId;
        untracked(() => void this.loadRepository(repositoryId));
      }
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      this.workspaceHints();
      untracked(() => void this.loadWorkspace(workspaceId));
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      this.agentHints();
      untracked(() => void this.loadAgents(workspaceId));
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      this.processHints();
      untracked(() => void this.loadActiveProcess(workspaceId));
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      untracked(() => {
        if (workspaceId > 0) {
          this.events.open(workspaceId);
        }
        this.history.set(IDLE);
        this.sessions.set(IDLE);
        this.transcript.set(IDLE);
        this.readingSession = null;
        this.shownProcessId.set(null);
        this.daemon.resetReachability();
      });
    });

    // A resolved workspace answers 404; its record is read once and never on a hint.
    effect(() => {
      const missing = this.missing();
      const workspaceId = this.workspaceId();
      untracked(() => {
        if (!missing) {
          return;
        }
        if (this.history().kind === 'idle') {
          void this.loadHistory(workspaceId);
        }
        if (this.sessions().kind === 'idle') {
          void this.loadSessions(workspaceId);
        }
      });
    });

    // Which archived session is open is in the URL, so a reload lands on the same conversation.
    effect(() => {
      const sessionId = this.missing() ? this.selectedSession() : null;
      const workspaceId = this.workspaceId();
      untracked(() => {
        if (sessionId === this.readingSession) {
          return;
        }
        this.readingSession = sessionId;
        this.transcript.set(IDLE);
        if (sessionId) {
          void this.loadTranscript(workspaceId, sessionId);
        }
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.events.close();
      this.daemon.resetReachability();
      this.clearLinger();
    });
  }

  // ---- what is on screen ----------------------------------------------------------------------

  protected readonly workspace = computed<WorkspaceDto | null>(() => {
    const state = this.workspaceState();
    return state.kind === 'ready' && state.value.id === this.workspaceId() ? state.value : null;
  });

  /** The workspace answered 404: it has resolved, or it was never here. */
  protected readonly missing = computed(() => {
    const state = this.workspaceState();
    return state.kind === 'error' && state.status === 404;
  });

  protected readonly repositoryName = computed(() => {
    const state = this.repository();
    return state.kind === 'ready' ? (state.value.name ?? state.value.id) : '';
  });

  protected readonly agentList = computed<readonly AgentDto[]>(() => {
    const state = this.agents();
    return state.kind === 'ready' ? state.value : [];
  });

  /** Whether the resolved workspace ran on a runner, whose node keeps its transcripts. */
  protected readonly runnerPlaced = computed(() => {
    const history = this.history();
    return history.kind === 'ready' && history.value.placement === 'RUNNER';
  });

  protected readonly selectedSession = computed(() => this.query().get('session'));

  protected readonly conversation = computed(() => {
    const state = this.transcript();
    return state.kind === 'ready' && state.value.length > 0
      ? buildConversation(state.value)
      : EMPTY_CONVERSATION;
  });

  protected label(agent: AgentDto): string {
    return agentLabel(agent);
  }

  protected runState(agent: AgentDto): string {
    return runStateLabel(agent);
  }

  protected activity(agent: AgentDto): string | null {
    return activityLabel(agent.activity ?? null);
  }

  protected stateTone(agent: AgentDto) {
    return agentStateTone(agent.state);
  }

  /** The agent's work item in qits-projects, or undefined when no address can be spelled. */
  protected workItemHref(agent: AgentDto): string | undefined {
    const link = workItemLink(agent);
    return link
      ? this.appLinks.href('qits-projects', link.path, { project: link.project })
      : undefined;
  }

  protected agentRoute(agent: AgentDto): readonly unknown[] {
    return [...this.home(), 'agents', agent.agentId];
  }

  // ---- reads ----------------------------------------------------------------------------------

  private async loadRepository(repositoryId: string): Promise<void> {
    if (!repositoryId) {
      this.repository.set(IDLE);
      return;
    }
    try {
      this.repository.set(ready(await this.projectsApi.repository(repositoryId)));
    } catch (error) {
      this.repository.set(failed(error));
    }
  }

  protected async loadWorkspace(workspaceId: number): Promise<void> {
    if (workspaceId <= 0) {
      this.workspaceState.set(IDLE);
      return;
    }
    try {
      const workspace = await this.workspacesApi.workspace(workspaceId);
      if (this.workspaceId() === workspaceId) {
        this.workspaceState.set(ready(workspace));
      }
    } catch (error) {
      if (this.workspaceId() === workspaceId) {
        this.workspaceState.set(failed(error));
      }
    }
  }

  protected async loadAgents(workspaceId: number): Promise<void> {
    if (workspaceId <= 0) {
      this.agents.set(IDLE);
      return;
    }
    try {
      const agents = await this.agentsApi.agents({ workspaceId });
      if (this.workspaceId() === workspaceId) {
        this.agents.set(ready(agents.filter((agent) => agent.state !== 'REMOVED')));
      }
    } catch (error) {
      if (this.workspaceId() === workspaceId) {
        this.agents.set(failed(error));
      }
    }
  }

  protected async loadHistory(workspaceId: number): Promise<void> {
    this.history.set(LOADING);
    try {
      this.history.set(ready(await this.workspacesApi.history(workspaceId)));
    } catch (error) {
      this.history.set(failed(error));
    }
  }

  /** The archived agent sessions, from the host: a resolved workspace has no container to ask. */
  protected async loadSessions(workspaceId: number): Promise<void> {
    this.sessions.set(LOADING);
    try {
      this.sessions.set(ready(await this.workspacesApi.agentSessions(workspaceId)));
    } catch (error) {
      this.sessions.set(failed(error));
    }
  }

  protected async loadTranscript(workspaceId: number, sessionId: string): Promise<void> {
    this.transcript.set(LOADING);
    try {
      this.transcript.set(ready(await this.workspacesApi.agentTranscript(workspaceId, sessionId)));
    } catch (error) {
      this.transcript.set(failed(error));
    }
  }

  protected reloadTranscript(): void {
    const sessionId = this.selectedSession();
    if (sessionId) {
      void this.loadTranscript(this.workspaceId(), sessionId);
    }
  }

  /** What is starting the container, if anything. A null answer lets a shown section linger out. */
  private async loadActiveProcess(workspaceId: number): Promise<void> {
    if (workspaceId <= 0) {
      return;
    }
    try {
      const processId = await this.workspacesApi.activeProcess(workspaceId);
      if (processId) {
        this.clearLinger();
        this.shownProcessId.set(processId);
      } else if (this.shownProcessId()) {
        this.startLinger();
      }
    } catch {
      // The Starting section is an extra; a failed lookup leaves the page as it was.
    }
  }

  // ---- what the page does ---------------------------------------------------------------------

  protected chooseSession(sessionId: string): void {
    const open = this.selectedSession() === sessionId;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { session: open ? null : sessionId },
      queryParamsHandling: 'merge',
    });
  }

  protected onSettled(): void {
    this.events.invalidateAll();
    this.startLinger();
  }

  protected onStarted(processId: string): void {
    this.clearLinger();
    this.shownProcessId.set(processId);
  }

  protected onChanged(): void {
    void this.loadWorkspace(this.workspaceId());
  }

  protected reload(): void {
    void this.loadWorkspace(this.workspaceId());
    void this.loadAgents(this.workspaceId());
  }

  private startLinger(): void {
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.shownProcessId.set(null);
      this.linger = null;
    }, LINGER_MS);
  }

  private clearLinger(): void {
    if (this.linger) {
      clearTimeout(this.linger);
      this.linger = null;
    }
  }
}
