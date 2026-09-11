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
import {
  QITS_REPOSITORIES,
  QITS_SCOPE,
  QitsAppLinks,
  scopeCommands,
} from '@qits/ui-components';
import type { ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { serverMessage } from '../ui/loadable';
import {
  workspaceSubject,
  workspaceSubjectLabel,
  workspaceSubjectPath,
  type WorkspaceSubject,
} from '../ui/workspace-subject';

/** One project's wrapper repository, named as the picker shows it. */
interface Choice {
  readonly project: ProjectDto;
  readonly repository: RepositoryDto;
}

/**
 * The root view: the aggregate workspaces that exist, and the one form that makes another.
 *
 * **The address picks the repository when it names one.** `/qits/services/qits-ci/` is a request for
 * that repository's workspaces, and `/qits/…` with no repository resolved is a request for the
 * project's wrapper — the repository an aggregate workspace actually branches. In both cases the
 * picker is not drawn: it would be a control offering to contradict the URL.
 *
 * **Unscoped, the picker is still the way in.** Every project's wrapper is offered, and only its
 * wrapper. An aggregate workspace branches a
 * wrapper and every registered submodule under it, so an ordinary component repository would offer
 * a create the service refuses. The rule is the service's own answer and not a derivation of it:
 * the repositories read carries a `wrapper` view whose `repositoryId` names the row, and this page
 * admits that row. It used to filter on the literal name `qits-qits`, which offered the platform's
 * own wrapper and no other project's.
 *
 * **`?repository=<id>` preselects one.** The projects SPA links here from a project's own page, and
 * an id naming no admitted wrapper is ignored — a stale link lands on the ordinary first choice
 * rather than on an empty picker.
 *
 * **The list needs a repository before it can be read.** qits-workspaces' listing takes a mandatory
 * `repositoryId`, so with no choice admitted there is nothing to ask for and the page shows an empty
 * list rather than a failed request.
 *
 * **"Enable docker socket" is admin mode, and it is per workspace.** Ticked, the create asks
 * qits-workspaces for a workspace whose container holds the host's docker socket — which makes that
 * container root-equivalent on the host — so administration can be done from inside a workspace. It
 * starts unticked on every press, is never remembered, and the list marks the workspaces that hold
 * it: a privilege nobody can see is one nobody gives back.
 *
 * **Create is three steps in a fixed order**: the service forks the branch tree, the container is
 * then asked to start, and only then does the page navigate to the detail view — which is where the
 * starting process is actually watched. Navigating first would leave the container unstarted if the
 * second request never went out.
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
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly qitsScope = inject(QITS_SCOPE);
  private readonly appLinks = inject(QitsAppLinks);
  private readonly qitsRepositories = inject(QITS_REPOSITORIES);

  protected readonly choices = signal<readonly Choice[]>([]);

  /**
   * Every repository row this page has seen, by id. The picker offers wrappers alone, but a scoped
   * address can name any repository, and a create needs that row's main branch to fork from.
   */
  protected readonly rows = signal<ReadonlyMap<string, RepositoryDto>>(new Map());
  protected readonly workspaces = signal<readonly WorkspaceDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected branch = 'adhoc-changes';
  protected selectedRepositoryId = '';

  /**
   * The admin-mode checkbox: create this workspace with the host's docker socket mounted.
   *
   * **It resets to false and is never remembered.** A container holding that socket is
   * root-equivalent on the host, so the answer has to be given per workspace rather than inherited
   * from the last one somebody made — a sticky preference here would grant the socket to workspaces
   * nobody thought about.
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

  /**
   * What a row is for, where a dispatch said so — the reference that makes a list of branch names
   * answer "what is this workspace about" without opening one. `null` for a hand-made workspace.
   */
  protected subjectOf(workspace: WorkspaceDto): WorkspaceSubject | null {
    return workspaceSubject(workspace);
  }

  /** How the reference reads. */
  protected labelOf(subject: WorkspaceSubject): string {
    return workspaceSubjectLabel(subject);
  }

  /**
   * Where the reference points, or `undefined` when this page cannot honestly spell the address —
   * the platform has stated no origin for qits-projects yet, no project is on screen, or the branch
   * spells no slug. The label is rendered either way.
   *
   * <p>The project comes from the address when there is one and from the picked repository's project
   * otherwise, because the unscoped form is a picker over every project's wrapper and the rows below
   * it belong to whichever one is selected.
   */
  protected subjectHrefOf(subject: WorkspaceSubject): string | undefined {
    const project = this.qitsScope.scope().project ?? this.selectedProjectSlug();
    if (!project) {
      return undefined;
    }
    const path = workspaceSubjectPath(subject);
    return path ? this.appLinks.href('qits-projects', path, { project }) : undefined;
  }

  /** The picked repository's project, for the unscoped form. */
  private selectedProjectSlug(): string | undefined {
    return this.choices().find((choice) => choice.repository.id === this.selectedRepositoryId)
      ?.project.slug;
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

  protected async create(): Promise<void> {
    // The row rather than the picker's choice: a scoped address can name a repository the picker
    // does not offer, and what a create needs from it is the branch to fork.
    const repository = this.rows().get(this.selectedRepositoryId);
    const branch = this.branch.trim();
    if (!repository || !branch || this.creating()) return;
    // The service accepts `[A-Za-z0-9_-]{1,64}` as a workspace id and refuses anything else with a
    // 400, so a branch name that carries no such character has no id to send at all.
    const id = this.slug(branch);
    if (!id) {
      this.error.set('The branch name needs a letter or a number.');
      return;
    }
    this.creating.set(true);
    this.error.set(null);
    try {
      const created = await this.workspacesApi.createWorkspace({
        repositoryId: repository.id,
        id,
        parent: repository.mainBranch,
        branch,
        preamble: '',
        adoptExisting: false,
        branchTree: true,
        // The posture, as the checkbox stands at the moment of the press. Sent explicitly rather
        // than omitted-when-false so the request says what was asked for either way; the service
        // reads a missing field as no, which is what every other caller relies on.
        admin: this.admin,
      });
      await this.workspacesApi.ensureContainer(created.id);
      await this.router.navigate([
        ...this.home(),
        'repositories',
        repository.id,
        'workspaces',
        created.id,
      ]);
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not create the workspace.'));
      // The list is re-read because a 409 usually means the workspace is already there. A failure
      // of that read must not overwrite the message that explains the press.
      await this.reload().catch(() => undefined);
    } finally {
      this.creating.set(false);
    }
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

  private async reload(): Promise<void> {
    this.listed = this.selectedRepositoryId;
    if (!this.selectedRepositoryId) {
      this.workspaces.set([]);
      return;
    }
    this.workspaces.set(await this.workspacesApi.workspaces(this.selectedRepositoryId));
  }

  private slug(branch: string): string {
    return branch
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  /** The service's own words when it sent any, and this page's sentence when it did not. */
  private message(failure: unknown, fallback: string): string {
    const body = failure instanceof HttpErrorResponse ? failure.error : null;
    return serverMessage(body) ?? fallback;
  }
}
