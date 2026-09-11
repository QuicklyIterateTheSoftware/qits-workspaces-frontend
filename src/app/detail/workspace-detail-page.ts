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
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { QITS_SCOPE, QitsAppLinks, scopeCommands } from '@qits/ui-components';
import type { RepositoryDto, WorkspaceDto, WorkspaceHistoryDetailDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspaceCommands } from '../api/workspace-commands';
import { WorkspaceDaemonApi } from '../api/workspace-daemon-api';
import { WorkspaceEvents, anyOf } from '../api/workspace-events';
import { WorkspaceServices } from '../api/workspace-services';
import { WorkspacesApi } from '../api/workspaces-api';
import type { MergeResult } from '../merge/merge-outcome';
import { Async } from '../ui/async';
import {
  workspaceSubject,
  workspaceSubjectLabel,
  workspaceSubjectPath,
} from '../ui/workspace-subject';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { ActionsPanel } from './actions/actions-panel';
import { ActivityBar } from './activity-bar';
import { AgentActivityMemory } from './agent-activity-memory';
import { AgentsPanel } from './agents/agents-panel';
import { ChatPanel } from './chat/chat-panel';
import { FilesPanel } from './files/files-panel';
import { PanelPlaceholder } from './panel-placeholder';
import { ServicesPanel } from './services/services-panel';
import { StartingPanel } from './starting/starting-panel';
import { StatusStrip } from './status-strip';
import { TabHost } from './tabs/tab-host';
import { TabPanel } from './tabs/tab-panel';
import { DEFAULT_TAB, DURABLE_TABS, STARTING_SLUG, isDurableTab, type TabDef } from './tabs/tabs';
import { WebViewPanel } from './web-view/web-view-panel';

/**
 * How long the transient tab stays after its operation finishes.
 *
 * Without it a fast container start flashes a tab nobody gets to read, and the final state — which
 * is the whole reason to look — is the part that vanishes fastest.
 */
export const LINGER_MS = 5000;

/**
 * What each durable tab says while its panel is still to come.
 *
 * Empty now that every tab has one. Kept, because {@link WorkspaceDetailPage.panelNote} is what a
 * tab added ahead of its panel falls back to, and a placeholder that names the surface is a better
 * screen than an empty box.
 */
const PANEL_NOTES: Readonly<Record<string, string>> = {};

/**
 * The room you sit in while a coding agent changes a workspace.
 *
 * ## What it loads
 *
 * **On load this page reads `3 + T`, plus one stream**, where `T` is the selected tab's own budget:
 *
 * 1. `GET /projects/api/repositories/{repositoryId}` — the repository's default branch, and the only
 *    thing that decides whether this workspace can be *integrated* from here at all.
 * 2. `GET /workspaces/api/workspaces?repositoryId=` — one entry feeding the header, the status strip
 *    **and** the activity bar. It is the list rather than the single-workspace read because the bar
 *    needs every workspace in the repository anyway, so reading one on top of it would be a second
 *    request for data already in hand.
 * 3. `GET /workspaces/api/workspaces/{id}/active-process` — whether the transient Starting tab exists.
 * 4. The workspace's hint channel, `GET /workspaces/api/workspaces/{id}/events`.
 *
 * A fourth request happens in exactly one case: the id is **not** in the active list, which means the
 * work has resolved, and `GET /workspaces/api/history/{id}` is what there is left to show.
 *
 * Two honest costs. The channel's first `onopen` re-issues reads 2 and 3, because the rule is
 * "invalidate everything on every connect" and a first connect is a connect — one duplicate burst is
 * the price of having one rule instead of two, and of never having to reason about which reconnect
 * was the first. And a tab switch to a tab that has not been opened yet costs that tab's requests,
 * which is why the tab is in the URL: it is expensive state, so it is addressable state.
 *
 * **Nothing on this page polls.** The explorer screens poll because they have no channel; this one
 * has one, and an idle workspace produces no traffic at all.
 *
 * ## The URL
 *
 * `repositories/{repositoryId}/workspaces/{workspaceId}?tab=…`. The repository segment is not
 * decoration — the workspace listing takes a mandatory `repositoryId` and answers 404 without one.
 *
 * **The tab is a query parameter and not a trailing path segment**, which is what the original used.
 * A trailing segment gets tab-switch-without-remount for free, and gets *workspace*-switch-without-
 * remount too, which is a bug: the page would keep showing the previous workspace's data. `?tab=`
 * removes the question, keeps every tab a shareable link, and makes a bare URL mean "no tab pinned"
 * by simple absence rather than by a slug someone has to strip. An unknown slug is normalised away
 * back to the bare URL; a bare URL is never helpfully filled in.
 *
 * A *workspace* change is still a path change under one route config, so Angular reuses this
 * component — hence {@link mounted}, which is the one place that reuse is worth fighting.
 */
@Component({
  selector: 'app-workspace-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActionsPanel,
    ActivityBar,
    AgentsPanel,
    Async,
    ChatPanel,
    FilesPanel,
    PanelPlaceholder,
    ServicesPanel,
    StartingPanel,
    StatusStrip,
    TabHost,
    TabPanel,
    WebViewPanel,
  ],
  templateUrl: './workspace-detail-page.html',
  styleUrl: './workspace-detail-page.css',
})
export class WorkspaceDetailPage {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly events = inject(WorkspaceEvents);
  private readonly memory = inject(AgentActivityMemory);
  private readonly serviceEntry = inject(WorkspaceServices);
  private readonly commandEntry = inject(WorkspaceCommands);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly appLinks = inject(QitsAppLinks);

  /**
   * Where this page's own links start. The same workspace is reachable bare and under the
   * repository the reader came in through, so an absolute link written `/` would drop them out of
   * the second form without saying so.
   */
  protected readonly home = computed<string[]>(() => [...scopeCommands(this.qitsScope.scope())]);

  private readonly params = toSignal(this.route.paramMap, { initialValue: convertToParamMap({}) });
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly repositoryId = computed(() => this.params().get('repositoryId') ?? '');
  protected readonly workspaceId = computed(() => Number(this.params().get('workspaceId') ?? 0));

  protected readonly repository = signal<Loadable<RepositoryDto>>(LOADING);
  protected readonly workspaces = signal<Loadable<readonly WorkspaceDto[]>>(LOADING);
  protected readonly history = signal<Loadable<WorkspaceHistoryDetailDto>>(IDLE);

  /**
   * The remount guard.
   *
   * Angular reuses a component when only a path parameter changes, which is right for a tab and wrong
   * for a workspace: the page reads its identity into a dozen signals and a live channel, and a reused
   * instance would keep the previous workspace's everything. So a change of `workspaceId` sets this
   * false, and a microtask later sets it true — one frame with the subtree gone is what actually
   * destroys it. Three lines, explicit, and cheaper than making every piece of state re-entrant.
   */
  protected readonly mounted = signal(true);
  private mountedFor: number | null = null;

  /**
   * How many times the guard has fired. Public because a spec is its only reader, and because the
   * thing worth asserting — a *tab* change reuses and a *workspace* change does not — is invisible
   * from the DOM once the microtask has been and gone.
   */
  readonly remounts = signal(0);

  /** The process the transient tab is showing, which outlives the process itself by {@link LINGER_MS}. */
  protected readonly shownProcessId = signal<string | null>(null);
  private linger: ReturnType<typeof setTimeout> | null = null;
  private autoSelected: string | null = null;

  /** Whether the transient tab currently holds the selection. Never written to the URL. */
  private readonly transient = signal(false);

  /** Every merge made from this page — kept because a merge resolves the workspace under it. */
  protected readonly landed = signal<readonly MergeResult[]>([]);

  private loadedRepositoryId: string | null = null;

  /** Which repository the list on hand belongs to. Read by {@link missing}. */
  private readonly listedRepositoryId = signal<string | null>(null);

  /**
   * What makes the workspace row stale: its agent activity, its cleanliness and its container's
   * lifecycle. `git-status` is included although the service fires it on the repository channel,
   * which no controller serves — it costs a signal read and it is right the day one does.
   */
  private readonly workspaceHints = anyOf(this.events, 'agent-activity', 'git-status', 'process');
  private readonly processHints = this.events.invalidations('process');

  constructor() {
    // Every load is driven off the URL and never off a click, which is what makes a deep link, the
    // back button and a press behave identically.
    effect(() => {
      const repositoryId = this.repositoryId();
      if (repositoryId !== this.loadedRepositoryId) {
        this.loadedRepositoryId = repositoryId;
        void this.loadRepository(repositoryId);
      }
    });

    effect(() => {
      const repositoryId = this.repositoryId();
      this.workspaceHints();
      untracked(() => void this.loadWorkspaces(repositoryId));
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      this.processHints();
      untracked(() => void this.loadActiveProcess(workspaceId));
    });

    effect(() => {
      const workspaceId = this.workspaceId();
      if (workspaceId > 0) {
        this.events.open(workspaceId);
      }
    });

    effect(() => this.guardRemount(this.workspaceId()));

    // A resolved workspace is not in the active list, so a missing id is the signal to read the
    // record instead. It is asked once and never on a hint: a resolved workspace does not change.
    effect(() => {
      const missing = this.missing();
      const workspaceId = this.workspaceId();
      untracked(() => {
        if (missing && this.history().kind === 'idle') {
          void this.loadHistory(workspaceId);
        }
      });
    });

    // A slug nobody recognises is normalised away rather than obeyed — and rather than being left in
    // the URL looking like it meant something.
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

    // A process that has just appeared takes the selection. Once per process, so someone who moved
    // to another tab is not dragged back by the next frame of the same log.
    effect(() => {
      const processId = this.shownProcessId();
      if (processId && processId !== this.autoSelected) {
        this.autoSelected = processId;
        untracked(() => this.transient.set(true));
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.events.close();
      this.daemon.resetReachability();
      if (this.linger) {
        clearTimeout(this.linger);
      }
    });
  }

  // ---- what is on screen ---------------------------------------------------------------------

  protected readonly workspace = computed<WorkspaceDto | null>(() => {
    const state = this.workspaces();
    if (state.kind !== 'ready') {
      return null;
    }
    return state.value.find((entry) => entry.id === this.workspaceId()) ?? null;
  });

  /**
   * The list loaded, it is *this* repository's, and this workspace is not in it: the work has
   * resolved, or it was never here.
   *
   * The repository check is not belt and braces. Moving to a workspace in another repository changes
   * two parameters at once, and for the moment between them the page holds the previous repository's
   * list — in which the new id is of course absent. Without the check, every such move would read a
   * history record and flash "this workspace is finished" at a workspace that is running.
   */
  protected readonly missing = computed(
    () =>
      this.workspaces().kind === 'ready' &&
      this.listedRepositoryId() === this.repositoryId() &&
      this.workspace() === null,
  );

  protected readonly workspaceList = computed(() => {
    const state = this.workspaces();
    return state.kind === 'ready' ? state.value : [];
  });

  protected readonly mainBranch = computed(() => {
    const state = this.repository();
    return state.kind === 'ready' ? state.value.mainBranch : '';
  });

  /**
   * What this workspace is for, where a dispatch said so — the reference that stands in place of the
   * prose goal, and `null` for a workspace a person created by hand.
   */
  protected readonly subject = computed(() => workspaceSubject(this.workspace()));

  /** How the reference reads. `Ticket fix-login`, never the id. */
  protected readonly subjectLabel = computed(() => {
    const subject = this.subject();
    return subject ? workspaceSubjectLabel(subject) : '';
  });

  /**
   * Where the reference points, or `undefined` for a name this page cannot honestly spell — the
   * platform has not served its navigation yet, the address names no project, or the branch spells
   * no slug. The label is still rendered then: the field says what the workspace is for whether or
   * not there is somewhere to send a click.
   *
   * <p>Composed through {@link QitsAppLinks}, the chrome's own cross-application seam, rather than
   * onto an origin this page works out: an application's origin is something the platform states
   * (`/main-navigation`), and every time a frontend here derived one instead it got it wrong — see
   * `editor/editor-origin`, which carries three of those.
   */
  protected readonly subjectHref = computed(() => {
    const subject = this.subject();
    const project = this.qitsScope.scope().project;
    if (!subject || !project) {
      return undefined;
    }
    const path = workspaceSubjectPath(subject);
    // The project alone, never the scope on screen: this page's address may name a repository, and
    // qits-projects serves no ticket under one.
    return path ? this.appLinks.href('qits-projects', path, { project }) : undefined;
  });

  /**
   * What the prompt-rewrite call is told this workspace is about.
   *
   * The goal where a person wrote one, and **the short reference** for a dispatched workspace, which
   * has no goal any more. Not the ticket's text: nothing on this side has it, and fetching it per
   * rewrite would be a cross-application read for a hint. A reference is a small, true thing to say,
   * which is better than the stale paragraph it replaces and than saying nothing.
   */
  protected readonly rewriteContext = computed(
    () => this.subjectLabel() || this.workspace()?.preamble || null,
  );

  protected readonly title = computed(() => this.workspace()?.workspaceId ?? 'Workspace');

  protected readonly reachability = this.daemon.reachability;
  protected readonly live = this.events.connected;

  protected readonly urlTab = computed(() => {
    const slug = this.query().get('tab');
    return isDurableTab(slug) ? slug! : DEFAULT_TAB;
  });

  protected readonly selected = computed(() =>
    this.transient() && this.shownProcessId() ? STARTING_SLUG : this.urlTab(),
  );

  /**
   * A terminal run this workspace is doing that no agent is driving — the Actions dot.
   *
   * The split is deliberate and each dot points at its own tab: a chat has the Chat tab's, an agent
   * run has the Agents tab's, and a service has the Services tab's. The history list below still
   * shows every one of them; it is only the *label* that is narrowed, so a glance at the strip says
   * which tab to open rather than merely that something is happening somewhere.
   *
   * "Agent-driven" is read off `agentSessions` rather than off the kind, because an interactive agent
   * launch is a PTY like any other terminal run — what makes it the agent's is that a session is
   * pinned to it.
   */
  private readonly runningAction = computed(() => {
    const state = this.commandEntry.commands();
    if (state.kind !== 'ready') {
      return false;
    }
    return state.value.some(
      (command) =>
        command.kind === 'TERMINAL' &&
        command.status === 'RUNNING' &&
        command.agentSessions.length === 0,
    );
  });

  /**
   * The row: the transient tab when there is one, then the six.
   *
   * **Every dot here is drawn from something already in hand, and none of them costs a request.** The
   * Agents dot reads the workspace entry the strip already holds; the Services and Actions dots read
   * the two shared entries, which answer "nothing to say" until a panel has asked for them. That is
   * what keeps the shell's load budget at what it says it is: a dot on a tab nobody has opened would
   * otherwise mean a fetch on every page open for a tab nobody may visit, on a screen whose stated
   * property is that an idle workspace produces no traffic at all. Absence of a dot means "not
   * asked", never "nothing running", and one click resolves it.
   */
  protected readonly tabs = computed<readonly TabDef[]>(() => {
    const activity = this.workspace()?.agentActivity ?? null;
    const servicesDot = this.serviceEntry.dot();
    const running = this.runningAction();
    const durable = DURABLE_TABS.map((tab) => {
      if (tab.slug === 'agents' && activity) {
        return {
          ...tab,
          dot: activity === 'BUSY' ? ('accent' as const) : ('success' as const),
          dotTitle:
            activity === 'BUSY' ? 'The agent is working' : `Agent ${activity.toLowerCase()}`,
        };
      }
      if (tab.slug === 'services' && servicesDot) {
        return { ...tab, dot: servicesDot, dotTitle: this.serviceEntry.dotTitle() };
      }
      if (tab.slug === 'actions' && running) {
        return { ...tab, dot: 'accent' as const, dotTitle: 'An action is running' };
      }
      return tab;
    });
    return this.shownProcessId()
      ? [{ slug: STARTING_SLUG, label: 'Starting', inUrl: false, pinFront: true }, ...durable]
      : durable;
  });

  protected panelNote(slug: string): string {
    return PANEL_NOTES[slug] ?? '';
  }

  protected panelTitle(slug: string): string {
    return DURABLE_TABS.find((tab) => tab.slug === slug)?.label ?? slug;
  }

  protected readonly durableTabs = DURABLE_TABS;

  // ---- reads ------------------------------------------------------------------------------------

  protected async loadRepository(repositoryId: string): Promise<void> {
    if (!repositoryId) {
      this.repository.set(IDLE);
      return;
    }
    this.repository.set(LOADING);
    try {
      this.repository.set(ready(await this.projectsApi.repository(repositoryId)));
    } catch (error) {
      this.repository.set(failed(error));
    }
  }

  protected async loadWorkspaces(repositoryId: string): Promise<void> {
    if (!repositoryId) {
      this.workspaces.set(IDLE);
      return;
    }
    try {
      const workspaces = await this.workspacesApi.workspaces(repositoryId);
      this.memory.observe(workspaces);
      this.listedRepositoryId.set(repositoryId);
      this.workspaces.set(ready(workspaces));
    } catch (error) {
      this.workspaces.set(failed(error));
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

  /**
   * Ask what is running, and let the answer drive the transient tab.
   *
   * A null answer while a tab is showing means the operation finished without this page seeing its
   * terminal frame — a late attach, or a reload after the fact — so it starts the same linger rather
   * than leaving a tab that never closes.
   */
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
      // The transient tab is an extra, not the page. A failed lookup leaves the row as it was.
    }
  }

  // ---- what the page does -----------------------------------------------------------------------

  protected chooseTab(slug: string): void {
    if (slug === STARTING_SLUG) {
      this.transient.set(true);
      return;
    }
    this.transient.set(false);
    // A push rather than a replace, so the back button walks tabs.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: slug },
      queryParamsHandling: 'merge',
    });
  }

  /** An activity-bar button: that workspace's Chat tab, which is where the next prompt goes. */
  protected openWorkspace(workspaceRowId: number): void {
    void this.router.navigate(
      [...this.home(), 'repositories', this.repositoryId(), 'workspaces', workspaceRowId],
      { queryParams: { tab: 'chat' } },
    );
  }

  /** The Starting tab's process reached its terminal frame. */
  protected onSettled(): void {
    this.events.invalidateAll();
    this.startLinger();
  }

  protected onStarted(processId: string): void {
    this.clearLinger();
    this.shownProcessId.set(processId);
  }

  protected onChanged(): void {
    void this.loadWorkspaces(this.repositoryId());
  }

  protected onMerged(result: MergeResult): void {
    this.landed.update((records) => [result, ...records]);
  }

  protected reload(): void {
    void this.loadRepository(this.repositoryId());
    void this.loadWorkspaces(this.repositoryId());
  }

  // ---- plumbing ---------------------------------------------------------------------------------

  private guardRemount(workspaceId: number): void {
    if (this.mountedFor === null) {
      this.mountedFor = workspaceId;
      return;
    }
    if (this.mountedFor === workspaceId) {
      return;
    }
    this.mountedFor = workspaceId;
    untracked(() => {
      this.history.set(IDLE);
      this.shownProcessId.set(null);
      this.transient.set(false);
      this.autoSelected = null;
      this.daemon.resetReachability();
      this.remounts.update((count) => count + 1);
      this.mounted.set(false);
      queueMicrotask(() => this.mounted.set(true));
    });
  }

  private startLinger(): void {
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.shownProcessId.set(null);
      this.transient.set(false);
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
