import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { AgentDto, ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
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

const agent = (agentId: string, over: Partial<AgentDto> = {}): AgentDto => ({
  agentId,
  workspaceRowId: 12,
  repositoryId: 'qits-qits',
  workId: `work-${agentId}`,
  entityId: 'qits-617',
  entityTitle: 'Fix the login',
  wrapperBranch: 'ticket/qits-617',
  branches: [],
  state: 'ACTIVE',
  runState: 'RUNNING',
  admin: false,
  ...over,
});

const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 12,
  workspaceId: 'ws-12',
  parent: null,
  branch: null,
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
 * The front door: which wrapper it is about, the agents and workspaces it lists, and what one press
 * of "Create agent" sends.
 *
 * **The picker admits each project's wrapper, and the service is what says which row that is.**
 * `?repository=` preselects one; a stale id is ignored.
 *
 * **An agent is created for an existing ticket or epic (D24).** The item is read from qits-projects
 * first, so the request carries its UUID, its qualified id and its kind, and anything that is not a
 * ticket or an epic of the wrapper's project is refused before a request goes out.
 */
describe('WorkspacesPage', () => {
  let http: HttpTestingController;

  const PROJECTS_URL = '/projects/api/projects';
  const repositoriesUrl = (projectId: string) => `/projects/api/projects/${projectId}/repositories`;
  const workspacesUrl = (repositoryId: string) =>
    `/workspaces/api/workspaces?repositoryId=${repositoryId}`;
  const AGENTS_URL = '/workspaces/api/agents';
  const workItemUrl = (ref: string) => `/projects/api/work/${ref}`;

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
      agents?: readonly AgentDto[];
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
      http.expectOne(AGENTS_URL).flush({ agents: options.agents ?? [] });
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

  const projectOptions = (component: ComponentFixture<WorkspacesPage>): HTMLOptionElement[] =>
    Array.from(
      (component.nativeElement as HTMLElement).querySelectorAll('select[name="project"] option'),
    );

  const typeWorkItem = async (component: ComponentFixture<WorkspacesPage>, ref: string) => {
    const input = (component.nativeElement as HTMLElement).querySelector(
      'input[name="workItem"]',
    ) as HTMLInputElement;
    input.value = ref;
    input.dispatchEvent(new Event('input'));
    await settle(component);
  };

  const submit = async (component: ComponentFixture<WorkspacesPage>): Promise<void> => {
    (component.nativeElement as HTMLElement)
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(component);
  };

  it('offers the wrapper alone and lists its workspaces and agents', async () => {
    const component = await open({
      workspaces: [workspace()],
      agents: [agent('a1'), agent('a2', { repositoryId: 'other-wrapper', entityId: 'other-1' })],
    });

    const projectOptions = options(component).filter((option) =>
      option.closest('select[name="project"]'),
    );
    expect(projectOptions).toHaveLength(1);
    expect(projectOptions[0].textContent).toContain('qits-qits');
    expect(text(component)).toContain('ws-12');
    expect(text(component)).toContain('running');
    expect(text(component)).toContain('1 agent');
    // Only this wrapper's agents.
    expect(text(component)).toContain('qits-617');
    expect(text(component)).not.toContain('other-1');
    const link = (component.nativeElement as HTMLElement).querySelector('a[href="/agents/a1"]');
    expect(link).not.toBeNull();
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

    const labels = projectOptions(component).map((option) => option.textContent?.trim());
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

    expect(projectOptions(component)).toHaveLength(1);
    expect(projectOptions(component)[0].textContent).toContain('qits-ci');
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
    expect(text(component)).toContain('No workspaces right now');
    expect(projectOptions(component)).toHaveLength(0);
  });

  /** Drift: the wrapper names a row this project has not got. There is nothing to branch. */
  it('offers nothing for a wrapper the repository list does not hold', async () => {
    const component = await open({
      projects: [fixture(PROJECT, [repository('qits-ci')], 'qits-qits')],
    });

    expect(projectOptions(component)).toHaveLength(0);
  });

  it('preselects the wrapper the query parameter names', async () => {
    const widgets = project('p2', 'Widgets');
    const component = await open({
      url: '/?repository=widgets-widgets',
      projects: [
        fixture(PROJECT, [repository('qits-qits')], 'qits-qits'),
        fixture(widgets, [repository('widgets-widgets', { projectId: 'p2' })], 'widgets-widgets'),
      ],
      workspaces: [workspace()],
    });

    const select = (component.nativeElement as HTMLElement).querySelector('select');
    expect(select?.value).toBe('widgets-widgets');
    // The list read is the proof it took: it is scoped by the selected repository, and `open`
    // answered `widgets-widgets`'s url alone.
    expect(text(component)).toContain('ws-12');
  });

  it('ignores a query parameter naming no admitted wrapper', async () => {
    const component = await open({ url: '/?repository=qits-ci' });

    const select = (component.nativeElement as HTMLElement).querySelector('select');
    expect(select?.value).toBe('qits-qits');
  });

  it('reads the work item, creates an agent for it, then opens the agent', async () => {
    const component = await open();

    await typeWorkItem(component, 'qits-617');
    await submit(component);

    http
      .expectOne(workItemUrl('qits-617'))
      .flush({ id: 'uuid-617', archetype: 'TICKET', projectId: 'p1', qualifiedId: 'qits-617' });
    await settle(component);

    const create = http.expectOne(AGENTS_URL);
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({
      repositoryId: 'qits-qits',
      workId: 'uuid-617',
      entityId: 'qits-617',
      kind: 'TICKET',
      // Untouched checkbox, and the request says so rather than staying silent about it.
      admin: false,
    });
    create.flush({ agent: agent('a9'), fresh: true, agentLaunch: 'SCHEDULED' });
    await settle(component);

    expect(TestBed.inject(Location).path()).toBe('/agents/a9');
  });

  it('sends the epic kind, the harness and the instruction when given', async () => {
    const component = await open();
    const root = component.nativeElement as HTMLElement;

    await typeWorkItem(component, 'qits-600');
    const harness = root.querySelector('select[name="harness"]') as HTMLSelectElement;
    harness.value = harness.options[2].value;
    harness.dispatchEvent(new Event('change'));
    const instruction = root.querySelector('textarea[name="instruction"]') as HTMLTextAreaElement;
    instruction.value = 'start with the tests';
    instruction.dispatchEvent(new Event('input'));
    await settle(component);
    await submit(component);

    http
      .expectOne(workItemUrl('qits-600'))
      .flush({ id: 'uuid-600', archetype: 'EPIC', projectId: 'p1', qualifiedId: 'qits-600' });
    await settle(component);

    const create = http.expectOne(AGENTS_URL);
    expect(create.request.body).toMatchObject({
      kind: 'EPIC',
      harness: 'KIMI',
      instruction: 'start with the tests',
    });
    create.flush({ agent: agent('a8'), fresh: false, agentLaunch: 'SKIPPED_RUNNING' });
    await settle(component);
  });

  it('refuses a task: only a ticket or an epic gets an agent', async () => {
    const component = await open();
    await typeWorkItem(component, 'qits-700');
    await submit(component);

    http
      .expectOne(workItemUrl('qits-700'))
      .flush({ id: 'uuid-700', archetype: 'TASK', projectId: 'p1', qualifiedId: 'qits-700' });
    await settle(component);

    http.expectNone(AGENTS_URL);
    expect(text(component)).toContain('Only a ticket or an epic gets an agent');
  });

  it('refuses a work item of another project', async () => {
    const component = await open();
    await typeWorkItem(component, 'other-1');
    await submit(component);

    http
      .expectOne(workItemUrl('other-1'))
      .flush({ id: 'uuid-1', archetype: 'TICKET', projectId: 'p2', qualifiedId: 'other-1' });
    await settle(component);

    http.expectNone(AGENTS_URL);
    expect(text(component)).toContain('belongs to another project');
  });

  it('says plainly when there is no such work item', async () => {
    const component = await open();
    await typeWorkItem(component, 'qits-99999');
    await submit(component);

    http
      .expectOne(workItemUrl('qits-99999'))
      .flush({ message: 'no' }, { status: 404, statusText: 'Not Found' });
    await settle(component);

    expect(text(component)).toContain('There is no work item qits-99999');
  });

  it('asks for the docker socket only when the checkbox was ticked', async () => {
    const component = await open();

    const checkbox = (component.nativeElement as HTMLElement).querySelector(
      'input[name="admin"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await typeWorkItem(component, 'qits-617');
    await submit(component);

    http
      .expectOne(workItemUrl('qits-617'))
      .flush({ id: 'uuid-617', archetype: 'TICKET', projectId: 'p1', qualifiedId: 'qits-617' });
    await settle(component);
    const create = http.expectOne(AGENTS_URL);
    expect((create.request.body as { admin: boolean }).admin).toBe(true);
    create.flush({ agent: agent('a9', { admin: true }), fresh: true, agentLaunch: 'SCHEDULED' });
    await settle(component);
  });

  it('says which workspaces hold the socket', async () => {
    // A privileged workspace has to be visible as one from the list. It is the only place somebody
    // scanning the platform would notice a socket granted for one afternoon and never given back.
    const component = await open({
      workspaces: [workspace({ admin: true })],
    });

    // The badge, not the page text: the create form's own checkbox says "docker socket" too, so a
    // text match would pass on a list that marks nothing.
    const badge = (component.nativeElement as HTMLElement).querySelector('li .admin-badge');
    expect(badge?.textContent).toContain('docker socket');
  });

  it('leaves the ordinary workspaces unmarked', async () => {
    const component = await open({ workspaces: [workspace()] });

    expect((component.nativeElement as HTMLElement).querySelector('li .admin-badge')).toBeNull();
  });

  it('keeps the service’s own words when a create is refused, and re-reads the list', async () => {
    const component = await open();
    await typeWorkItem(component, 'qits-617');
    await submit(component);

    http
      .expectOne(workItemUrl('qits-617'))
      .flush({ id: 'uuid-617', archetype: 'TICKET', projectId: 'p1', qualifiedId: 'qits-617' });
    await settle(component);
    http
      .expectOne(AGENTS_URL)
      .flush(
        { message: 'No such repository: qits-qits' },
        { status: 404, statusText: 'Not Found' },
      );
    await settle(component);

    http.expectOne(workspacesUrl('qits-qits')).flush({ entries: [] });
    http.expectOne(AGENTS_URL).flush({ agents: [] });
    await settle(component);

    expect(text(component)).toContain('No such repository: qits-qits');
    expect(TestBed.inject(Location).path()).toBe('');
  });

  it('marks a runner-placed row with its runner', async () => {
    const component = await open({
      workspaces: [
        workspace({ placement: 'RUNNER', runner: { id: 'r-1', name: 'node-a' } }),
        workspace({ id: 13, workspaceId: 'ws-13', placement: 'DIRECT', runner: null }),
      ],
    });

    const rows = (component.nativeElement as HTMLElement).querySelectorAll('.slots li');
    expect(rows[0].querySelector('.runner-badge')?.textContent).toContain('on node-a');
    expect(rows[1].querySelector('.runner-badge')).toBeNull();
  });
});
