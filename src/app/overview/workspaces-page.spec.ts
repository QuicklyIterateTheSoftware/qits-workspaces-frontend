import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { routes } from '../app.routes';
import { WorkspacesPage } from './workspaces-page';

const project = (id: string, name: string): ProjectDto => ({
  id,
  name,
  slug: name.toLowerCase(),
  description: null,
  dns: null,
});

const PROJECT = project('p1', 'qits');

const repository = (id: string, over: Partial<RepositoryDto> = {}): RepositoryDto => ({
  id,
  name: id,
  backupUrl: `https://example.invalid/${id}.git`,
  mainBranch: 'main',
  archetype: 'SERVICE',
  projectId: 'p1',
  ...over,
});

const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 12,
  workspaceId: 'adhoc-changes',
  parent: 'main',
  branch: 'adhoc-changes',
  ahead: 0,
  behind: 0,
  conflictsWithParent: false,
  status: 'ACTIVE',
  runtimeStatus: 'RUNNING',
  runtimeError: null,
  clean: true,
  agentActivity: null,
  preamble: null,
  result: null,
  resolvedAt: null,
  daemonConnectedAt: null,
  daemonVersion: null,
  daemonBuildTime: null,
  daemonOutdated: null,
  ...over,
});

/** One project as the fan-out answers it: its rows, and which of them the wrapper is. */
interface ProjectFixture {
  readonly project: ProjectDto;
  readonly repositories: readonly RepositoryDto[];
  /** The wrapper's repository id, or null for a project that has no wrapper at all. */
  readonly wrapper: string | null;
}

const fixture = (
  dto: ProjectDto,
  repositories: readonly RepositoryDto[],
  wrapper: string | null,
): ProjectFixture => ({ project: dto, repositories, wrapper });

/**
 * The front door: what it offers to branch, and what one press actually sends.
 *
 * **The picker admits each project's wrapper, and the service is what says which row that is.** An
 * aggregate workspace forks a wrapper and everything registered under it, so offering an ordinary
 * component repository would offer a create the service refuses. The rule is the `wrapper` view's
 * `repositoryId` and nothing else — not a name, not an archetype — so a second project's wrapper has
 * to appear beside the first's, and every other row of both has to stay out.
 *
 * **`?repository=` is the projects SPA's link, and a stale one must not break the page.** An id
 * naming an admitted wrapper is preselected; an id naming anything else is ignored.
 *
 * **`branchTree` is the flag the whole feature hangs on.** Without it qits-workspaces makes the
 * plain single-repository workspace it always made, on the wrapper alone — a create that looks
 * successful and leaves every submodule unbranched. So the payload is asserted field by field.
 *
 * **The container is started before the page navigates.** The detail view watches a starting
 * process; navigating first and starting after would leave the container unstarted whenever the
 * second request never went out.
 */
describe('WorkspacesPage', () => {
  let http: HttpTestingController;

  const PROJECTS_URL = '/projects/api/projects';
  const repositoriesUrl = (projectId: string) => `/projects/api/projects/${projectId}/repositories`;
  const workspacesUrl = (repositoryId: string) =>
    `/workspaces/api/workspaces?repositoryId=${repositoryId}`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        // The chrome's two reads, as literals: with no project scoped they answer nothing, which
        // is the unscoped page these specs are about.
        provideQitsRepositoryList([]),
        provideQitsScope('repository'),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Let the request chain land, then render. One `whenStable` can return mid-chain. */
  const settle = async (component: ComponentFixture<WorkspacesPage>): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await component.whenStable();
    component.detectChanges();
  };

  /**
   * Open the page over one project holding the wrapper and one ordinary repository.
   *
   * `repositories` is answered per project because qits-projects has no all-repositories endpoint;
   * `workspaces` is only asked for once a wrapper is admitted, which is why the caller can leave it
   * out. `url` is a real navigation rather than a stubbed route, so the query parameter reaches the
   * page the way the browser delivers it.
   */
  const open = async (
    options: {
      projects?: readonly ProjectFixture[];
      workspaces?: readonly WorkspaceDto[];
      url?: string;
    } = {},
  ): Promise<ComponentFixture<WorkspacesPage>> => {
    const projects = options.projects ?? [
      fixture(PROJECT, [repository('qits-qits'), repository('qits-ci')], 'qits-qits'),
    ];
    if (options.url) {
      await TestBed.inject(Router).navigateByUrl(options.url);
    }
    const component = TestBed.createComponent(WorkspacesPage);
    await settle(component);

    http
      .expectOne(PROJECTS_URL)
      .flush({ entries: projects.map((entry) => ({ project: entry.project })) });
    await settle(component);

    for (const entry of projects) {
      http.expectOne(repositoriesUrl(entry.project.id)).flush({
        entries: entry.repositories.map((row) => ({ repository: row })),
        wrapper: entry.wrapper
          ? { repositoryId: entry.wrapper, branch: 'main', entries: [] }
          : null,
      });
    }
    await settle(component);

    const selected = selection(projects, options.url);
    if (selected) {
      http
        .expectOne(workspacesUrl(selected))
        .flush({ entries: (options.workspaces ?? []).map((entry) => ({ workspace: entry })) });
      await settle(component);
    }
    return component;
  };

  /** The same rule the page follows: the asked-for wrapper when it is admitted, else the first. */
  const selection = (projects: readonly ProjectFixture[], url?: string): string | null => {
    const admitted = projects
      .filter((entry) => entry.repositories.some((row) => row.id === entry.wrapper))
      .map((entry) => entry.wrapper as string);
    const asked = url
      ? new URL(url, 'https://example.invalid').searchParams.get('repository')
      : null;
    return (asked && admitted.includes(asked) ? asked : admitted[0]) ?? null;
  };

  const text = (component: ComponentFixture<WorkspacesPage>): string =>
    (component.nativeElement as HTMLElement).textContent ?? '';

  const options = (component: ComponentFixture<WorkspacesPage>): HTMLOptionElement[] =>
    Array.from((component.nativeElement as HTMLElement).querySelectorAll('option'));

  const submit = async (component: ComponentFixture<WorkspacesPage>): Promise<void> => {
    (component.nativeElement as HTMLElement)
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(component);
  };

  it('offers the wrapper alone and lists the workspaces it already has', async () => {
    const component = await open({ workspaces: [workspace({ branch: 'adhoc-changes' })] });

    expect(options(component)).toHaveLength(1);
    expect(options(component)[0].textContent).toContain('qits-qits');
    expect(text(component)).toContain('adhoc-changes');
    expect(text(component)).toContain('running');
  });

  it('offers one wrapper per project, named after the project', async () => {
    const widgets = project('p2', 'Widgets');
    const component = await open({
      projects: [
        fixture(PROJECT, [repository('qits-qits'), repository('qits-ci')], 'qits-qits'),
        fixture(
          widgets,
          [
            repository('widgets-widgets', { projectId: 'p2', archetype: 'PROJECT' }),
            repository('widgets-api', { projectId: 'p2' }),
          ],
          'widgets-widgets',
        ),
      ],
    });

    const labels = options(component).map((option) => option.textContent?.trim());
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('qits');
    expect(labels[0]).toContain('qits-qits');
    expect(labels[1]).toContain('Widgets');
    expect(labels[1]).toContain('widgets-widgets');
    // The ordinary components of both projects are refused by the same rule.
    expect(text(component)).not.toContain('qits-ci');
    expect(text(component)).not.toContain('widgets-api');
  });

  /**
   * The wrapper is whichever row the service names, and nothing about the name says so. A project
   * whose wrapper is called something else is still offered, and its like-named component is not.
   */
  it('follows the wrapper the service names rather than a repository’s name', async () => {
    const component = await open({
      projects: [fixture(PROJECT, [repository('qits-ci'), repository('qits-qits')], 'qits-ci')],
    });

    expect(options(component)).toHaveLength(1);
    expect(options(component)[0].textContent).toContain('qits-ci');
  });

  it('says a workspace with no runtime state is unknown rather than stopped', async () => {
    const component = await open({ workspaces: [workspace({ runtimeStatus: null })] });

    expect(text(component)).toContain('runtime unknown');
    expect(text(component)).not.toContain('stopped');
  });

  it('asks for no workspaces at all when the project holds no wrapper', async () => {
    const component = await open({
      projects: [fixture(PROJECT, [repository('qits-ci')], null)],
    });

    // No repository, no listing: qits-workspaces' listing takes a mandatory `repositoryId`, and
    // `http.verify()` in the teardown is what proves nothing was asked for anyway.
    expect(text(component)).toContain('No active workspaces yet');
    expect(options(component)).toHaveLength(0);
  });

  /** Drift: the wrapper names a row this project has not got. There is nothing to branch. */
  it('offers nothing for a wrapper the repository list does not hold', async () => {
    const component = await open({
      projects: [fixture(PROJECT, [repository('qits-ci')], 'qits-qits')],
    });

    expect(options(component)).toHaveLength(0);
  });

  it('preselects the wrapper the query parameter names', async () => {
    const widgets = project('p2', 'Widgets');
    const component = await open({
      url: '/?repository=widgets-widgets',
      projects: [
        fixture(PROJECT, [repository('qits-qits')], 'qits-qits'),
        fixture(widgets, [repository('widgets-widgets', { projectId: 'p2' })], 'widgets-widgets'),
      ],
      workspaces: [workspace({ branch: 'adhoc-changes' })],
    });

    const select = (component.nativeElement as HTMLElement).querySelector('select');
    expect(select?.value).toBe('widgets-widgets');
    // The list read is the proof it took: it is scoped by the selected repository, and `open`
    // answered `widgets-widgets`'s url alone.
    expect(text(component)).toContain('adhoc-changes');
  });

  it('ignores a query parameter naming no admitted wrapper', async () => {
    const component = await open({ url: '/?repository=qits-ci' });

    const select = (component.nativeElement as HTMLElement).querySelector('select');
    expect(select?.value).toBe('qits-qits');
  });

  it('creates the branch tree in one request, and then opens the workspace', async () => {
    const component = await open();

    await submit(component);

    const create = http.expectOne('/workspaces/api/workspaces');
    expect(create.request.body).toEqual({
      repositoryId: 'qits-qits',
      id: 'adhoc-changes',
      parent: 'main',
      branch: 'adhoc-changes',
      preamble: '',
      adoptExisting: false,
      branchTree: true,
      // Untouched checkbox, and the request says so rather than staying silent about it.
      admin: false,
    });
    // The create starts the workspace too (qits-853) and answers the start's process beside it.
    create.flush({ workspace: workspace(), technicalProcessId: 'p-1', startError: null });
    await settle(component);

    // No second call: the detail page finds the running start through its own active-process read.
    http.expectNone('/workspaces/api/workspaces/12/ensure-container');
    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-qits/workspaces/12');
  });

  it('asks for the docker socket only when the checkbox was ticked', async () => {
    const component = await open();

    const checkbox = (component.nativeElement as HTMLElement).querySelector(
      'input[name="admin"]',
    ) as HTMLInputElement;
    // The default is the whole claim: a workspace is ordinary unless somebody said otherwise, and
    // the container of an ordinary workspace holds no socket.
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await settle(component);

    await submit(component);

    const create = http.expectOne('/workspaces/api/workspaces');
    expect((create.request.body as { admin: boolean }).admin).toBe(true);
    create.flush({ workspace: workspace({ admin: true }) });
    await settle(component);
  });

  it('says which workspaces hold the socket', async () => {
    // A privileged workspace has to be visible as one from the list. It is the only place somebody
    // scanning the platform would notice a socket granted for one afternoon and never given back.
    const component = await open({
      workspaces: [workspace({ branch: 'admin-work', admin: true })],
    });

    // The badge, not the page text: the create form's own checkbox says "docker socket" too, so a
    // text match would pass on a list that marks nothing.
    const badge = (component.nativeElement as HTMLElement).querySelector('li .admin-badge');
    expect(badge?.textContent).toContain('docker socket');
  });

  it('leaves the ordinary workspaces unmarked', async () => {
    const component = await open({ workspaces: [workspace({ branch: 'ordinary' })] });

    expect((component.nativeElement as HTMLElement).querySelector('li .admin-badge')).toBeNull();
  });

  it('keeps the service’s own words when a create is refused, and re-reads the list', async () => {
    const component = await open();

    await submit(component);

    http
      .expectOne('/workspaces/api/workspaces')
      .flush(
        { message: 'Branch already exists in qits-ci: adhoc-changes' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle(component);

    http.expectOne(workspacesUrl('qits-qits')).flush({ entries: [] });
    await settle(component);

    expect(text(component)).toContain('Branch already exists in qits-ci: adhoc-changes');
    expect(TestBed.inject(Location).path()).toBe('');
  });
  it('marks a runner-placed row with its runner', async () => {
    const component = await open({
      workspaces: [
        workspace({ placement: 'RUNNER', runner: { id: 'r-1', name: 'node-a' } }),
        workspace({ id: 13, branch: 'direct', placement: 'DIRECT', runner: null }),
      ],
    });

    const rows = (component.nativeElement as HTMLElement).querySelectorAll('li');
    expect(rows[0].querySelector('.runner-badge')?.textContent).toContain('on node-a');
    expect(rows[1].querySelector('.runner-badge')).toBeNull();
  });
});
