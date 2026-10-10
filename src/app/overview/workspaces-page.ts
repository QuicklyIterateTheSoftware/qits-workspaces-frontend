import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { QITS_REPOSITORIES, QITS_SCOPE, QitsAppLinks, scopeCommands } from '@qits/ui-components';
import type {
  AgentDto,
  AgentHarness,
  ProjectDto,
  RepositoryDto,
  WorkItemDto,
  WorkspaceDto,
} from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspaceAgentsApi } from '../api/workspace-agents-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { runStateLabel } from '../detail/agent-labels';
import { serverMessage } from '../ui/loadable';
import { agentLabel, workItemLink } from '../ui/work-item';

/** One project's wrapper repository, named as the picker shows it. */
interface Choice {
  readonly project: ProjectDto;
  readonly repository: RepositoryDto;
}

/**
 * The root view: a wrapper's workspaces and agents, and the form that makes a new agent.
 *
 * **The address picks the wrapper when it names one.** A scoped address names a repository, or a
 * project whose wrapper is meant; the picker is not drawn then. Unscoped, the picker offers every
 * project's wrapper, and `?repository=<id>` preselects one.
 *
 * **A person creates an agent for an existing work item, never a free goal (D24).** The form takes
 * a ticket or epic, by qualified id (`qits-617`) or UUID, reads it from qits-projects to send its
 * UUID, qualified id and kind, and posts `POST /workspaces/api/agents`. The service places the agent
 * in a workspace (making one if a runner has room) and starts it; the page then opens the agent.
 *
 * **"Enable docker socket" is admin mode, per agent.** An admin agent runs only in an admin
 * workspace, whose container holds the host's docker socket. It starts unticked on every press.
 */
@Component({
  selector: 'app-workspaces-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  templateUrl: './workspaces-page.html',
  styleUrl: './workspaces-page.css',
})
export class WorkspacesPage implements OnInit {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly agentsApi = inject(WorkspaceAgentsApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly appLinks = inject(QitsAppLinks);
  private readonly qitsRepositories = inject(QITS_REPOSITORIES);

  protected readonly choices = signal<readonly Choice[]>([]);

  /**
   * Every repository row this page has seen, by id. The picker offers wrappers alone, but a scoped
   * address can name any repository, and a create needs that row and its project.
   */
  protected readonly rows = signal<ReadonlyMap<string, RepositoryDto>>(new Map());
  protected readonly workspaces = signal<readonly WorkspaceDto[]>([]);
  protected readonly agents = signal<readonly AgentDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected selectedRepositoryId = '';

  /** The work item, as typed: a qualified id (`qits-617`) or a UUID. */
  protected workItem = '';

  /** The harness; empty takes the service's default. */
  protected harness: AgentHarness | '' = '';

  /** The agent's first turn, optional. */
  protected instruction = '';

  protected readonly harnesses: readonly AgentHarness[] = ['CLAUDE', 'KIMI'];

  /**
   * The admin-mode checkbox. It resets to false after every create and is never remembered: an
   * admin agent's container is root-equivalent on the host.
   */
  protected admin = false;

  /** Where this page's own links start — bare, or under the repository the reader came in through. */
  protected readonly home = computed<string[]>(() => [...scopeCommands(this.qitsScope.scope())]);

  /**
   * The repository the address puts on screen: the one it names, or — when it names a project and
   * no repository of it — that project's wrapper, which is what an aggregate workspace branches.
   *
   * `undefined` while nothing is scoped, and while a scope has not resolved yet: the slug becomes an
   * id only once the chrome's project and repository listings answer.
   */
  protected readonly scopedRepositoryId = computed(() => {
    const scope = this.qitsScope.scope();
    if (!scope.project) return undefined;
    return scope.repository
      ? this.qitsScope.repositoryId()
      : this.qitsRepositories.wrapperRepositoryId();
  });

  protected labelOf(agent: AgentDto): string {
    return agentLabel(agent);
  }

  protected runStateOf(agent: AgentDto): string {
    return runStateLabel(agent);
  }

  /** The agent's work item in qits-projects, or undefined when no address can be spelled. */
  protected workItemHrefOf(agent: AgentDto): string | undefined {
    const link = workItemLink(agent);
    return link
      ? this.appLinks.href('qits-projects', link.path, { project: link.project })
      : undefined;
  }

  /** How many agents a workspace hosts, from the agent list on hand. */
  protected agentCount(workspace: WorkspaceDto): number {
    return this.agents().filter((agent) => agent.workspaceRowId === workspace.id).length;
  }

  /** Whether the address states a project. It is what hides the picker. */
  protected readonly scoped = computed(() => this.qitsScope.scope().project !== undefined);

  /** What the header says instead of the picker. */
  protected readonly scopeLabel = computed(() => {
    const scope = this.qitsScope.scope();
    return scope.repository ? `${scope.project} · ${scope.repository}` : (scope.project ?? '');
  });

  /** The repository the list was last read for, so a settling scope re-reads once and not per tick. */
  private listed: string | undefined = undefined;

  constructor() {
    // The scope resolves a moment after the first paint, so the list follows it rather than being
    // read once on arrival. Writing the selection is what keeps the create flow below unchanged:
    // scoped or picked, one field says which repository this page acts on.
    effect(() => {
      const scoped = this.scopedRepositoryId();
      if (!scoped || scoped === this.listed) return;
      this.selectedRepositoryId = scoped;
      void this.selectionChanged();
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const projects = await this.projectsApi.projects();
      const candidates = await Promise.all(
        projects.map(async (project) => ({
          project,
          components: await this.projectsApi.components(project.id),
        })),
      );
      const choices = candidates.flatMap(({ project, components }) => {
        const wrapperId = components.wrapper?.repositoryId;
        const repository = components.repositories.find((entry) => entry.id === wrapperId);
        // A wrapper the row list does not hold is drift the projects SPA reconciles; there is no
        // repository here to branch, so the project simply offers no choice.
        return repository ? [{ project, repository }] : [];
      });
      this.choices.set(choices);
      this.rows.set(
        new Map(
          candidates.flatMap(({ components }) =>
            components.repositories.map((entry) => [entry.id, entry] as const),
          ),
        ),
      );
      // A scoped address has already said which repository this is about, and the effect above
      // lists it — the picker's default would be a second answer to a question the URL settled.
      if (!this.scoped()) {
        this.selectedRepositoryId = this.preselected(choices) ?? choices[0]?.repository.id ?? '';
        await this.reload();
      }
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not load workspaces.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async selectionChanged(): Promise<void> {
    try {
      await this.reload();
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not load workspaces.'));
    }
  }

  /**
   * Create an agent for the typed work item.
   *
   * The item is read first: only a ticket or an epic of the wrapper's own project gets an agent, and
   * the service does not check that itself.
   */
  protected async create(): Promise<void> {
    const repository = this.rows().get(this.selectedRepositoryId);
    const ref = this.workItem.trim();
    if (!repository || !ref || this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    try {
      let item: WorkItemDto;
      try {
        item = await this.projectsApi.workItem(ref);
      } catch (failure) {
        const status = failure instanceof HttpErrorResponse ? failure.status : 0;
        this.error.set(
          status === 404
            ? `There is no work item ${ref}.`
            : this.message(failure, `Could not read the work item ${ref}.`),
        );
        return;
      }
      const refusal = this.refuse(item, repository);
      if (refusal) {
        this.error.set(refusal);
        return;
      }
      const harness = this.harness || undefined;
      const instruction = this.instruction.trim() || undefined;
      const answer = await this.agentsApi.create({
        repositoryId: repository.id,
        workId: item.id,
        entityId: item.qualifiedId,
        kind: item.archetype === 'EPIC' ? 'EPIC' : 'TICKET',
        // The posture as the checkbox stands at the press, sent either way.
        admin: this.admin,
        ...(harness ? { harness } : {}),
        ...(instruction ? { instruction } : {}),
      });
      this.admin = false;
      this.workItem = '';
      this.instruction = '';
      await this.router.navigate([...this.home(), 'agents', answer.agent.agentId]);
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not create the agent.'));
      await this.reload().catch(() => undefined);
    } finally {
      this.creating.set(false);
    }
  }

  /** Why this item cannot get an agent here, or null when it can. */
  private refuse(item: WorkItemDto, repository: RepositoryDto): string | null {
    if (item.archetype !== 'TICKET' && item.archetype !== 'EPIC') {
      return `${item.qualifiedId} is a ${item.archetype.toLowerCase()}. Only a ticket or an epic gets an agent.`;
    }
    if (repository.projectId && item.projectId && repository.projectId !== item.projectId) {
      return `${item.qualifiedId} belongs to another project than this wrapper.`;
    }
    return null;
  }

  /**
   * The wrapper `?repository=` asks for, when the picker actually holds it.
   *
   * An id that names nothing admitted answers null and the first choice stands. A link carried over
   * from a deleted project, or to a repository that is not a wrapper, is a stale link and not an
   * error worth stopping on.
   */
  private preselected(choices: readonly Choice[]): string | null {
    const asked = this.route.snapshot.queryParamMap.get('repository');
    return choices.some((choice) => choice.repository.id === asked) ? asked : null;
  }

  /** The wrapper's workspaces, and the agents working on it (every state but removed). */
  private async reload(): Promise<void> {
    const repositoryId = this.selectedRepositoryId;
    this.listed = repositoryId;
    if (!repositoryId) {
      this.workspaces.set([]);
      this.agents.set([]);
      return;
    }
    const [workspaces, agents] = await Promise.all([
      this.workspacesApi.workspaces(repositoryId),
      this.agentsApi.agents(),
    ]);
    if (this.selectedRepositoryId !== repositoryId) return;
    this.workspaces.set(workspaces);
    this.agents.set(
      agents.filter((agent) => agent.repositoryId === repositoryId && agent.state !== 'REMOVED'),
    );
  }

  /** The service's own words when it sent any, and this page's sentence when it did not. */
  private message(failure: unknown, fallback: string): string {
    const body = failure instanceof HttpErrorResponse ? failure.error : null;
    return serverMessage(body) ?? fallback;
  }
}
