import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QITS_NAVIGATION, toNavTree, type QitsNavTree } from '@qits/ui-components';
import { ProjectsApi } from './projects-api';

const PROJECTS_ORIGIN = 'https://projects.qits.example';

/**
 * qits-projects wraps every list in `entries`, and every entry in the name of the thing it holds.
 * That is genuinely different from the workspace listing's own envelope, so the client unwraps
 * rather than pretending the two services agree.
 *
 * It also answers on its own host now — the edge no longer routes its paths on this one — so every
 * read is an absolute URL on the origin the navigation names, carries the session, and is not made
 * at all until the navigation has said where that origin is.
 */
describe('ProjectsApi', () => {
  let tree: WritableSignal<QitsNavTree | undefined>;
  let api: ProjectsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    tree = signal<QitsNavTree | undefined>(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: QITS_NAVIGATION, useValue: { tree, failed: signal(false) } },
      ],
    });
    api = TestBed.inject(ProjectsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function answer(applications?: Record<string, { origin: string }>): void {
    tree.set(toNavTree({ slots: {}, applications }));
    TestBed.tick();
  }

  /** Lets the awaited URL resolve, so a request that is going out has gone out. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('asks nothing before the navigation says where qits-projects is', async () => {
    void api.projects();
    TestBed.tick();
    await settle();
    http.expectNone(() => true);
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    await settle();
    http.expectOne(`${PROJECTS_ORIGIN}/projects/api/projects`).flush({ entries: [] });
  });

  it('unwraps the project entries, on qits-projects’ own origin, with the session', async () => {
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const projects = api.projects();
    await settle();
    const request = http.expectOne(`${PROJECTS_ORIGIN}/projects/api/projects`);
    expect(request.request.withCredentials).toBe(true);
    request.flush({
      entries: [
        { project: { id: 'p1', name: 'qits', slug: 'qits', description: null, dns: null } },
      ],
    });
    await expect(projects).resolves.toMatchObject([{ id: 'p1', name: 'qits' }]);
  });

  it('unwraps one project’s repository entries and its wrapper, keeping the default branch', async () => {
    // `mainBranch` is the field this app came for: it is what an integrate lands on, and it is
    // named on screen rather than assumed to be "main". The wrapper rides along in the same answer,
    // which is what tells the picker which of the rows is the aggregate one.
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const components = api.components('p1');
    await settle();
    http.expectOne(`${PROJECTS_ORIGIN}/projects/api/projects/p1/repositories`).flush({
      entries: [
        {
          repository: {
            id: 'qits-ci',
            name: 'qits-ci',
            backupUrl: 'ssh://git@example/QuicklyIterate/qits-ci.git',
            mainBranch: 'main',
            archetype: 'SERVICE',
            projectId: 'p1',
          },
        },
      ],
      wrapper: { repositoryId: 'qits-qits', branch: 'main', entries: [] },
    });
    await expect(components).resolves.toMatchObject({
      repositories: [{ id: 'qits-ci', mainBranch: 'main' }],
      wrapper: { repositoryId: 'qits-qits' },
    });
  });

  /** A project with no wrapper holds no aggregate to branch, so the null has to survive the read. */
  it('keeps a missing wrapper as null rather than as an empty one', async () => {
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const components = api.components('p1');
    await settle();
    http
      .expectOne(`${PROJECTS_ORIGIN}/projects/api/projects/p1/repositories`)
      .flush({ entries: [] });
    await expect(components).resolves.toEqual({ repositories: [], wrapper: null });
  });

  it('reads a repository’s branches from its own path, not the project’s', async () => {
    // The branch list is the overview's other half: it is the only place a branch with no workspace
    // can be found, because qits-workspaces knows nothing about refs it did not create.
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const branches = api.branches('qits-ci');
    await settle();
    http.expectOne(`${PROJECTS_ORIGIN}/projects/api/repositories/qits-ci/branches`).flush({
      branches: [
        { name: 'main', canCleanup: false, parent: null, ahead: null, behind: null },
        { name: 'fix-lint', canCleanup: false, parent: null, ahead: null, behind: null },
      ],
    });
    await expect(branches).resolves.toMatchObject([{ name: 'main' }, { name: 'fix-lint' }]);
  });

  it('reads a branch-free repository as no branches rather than as a crash', async () => {
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const branches = api.branches('qits-ci');
    await settle();
    http.expectOne(`${PROJECTS_ORIGIN}/projects/api/repositories/qits-ci/branches`).flush({});
    await expect(branches).resolves.toEqual([]);
  });

  it('keeps the same-origin path where the navigation names no origin for qits-projects', async () => {
    answer();
    void api.projects();
    await settle();
    http.expectOne('/projects/api/projects').flush({ entries: [] });
  });

  it('reads one work item by qualified id, on qits-projects’ own origin', async () => {
    answer({ 'qits-projects': { origin: PROJECTS_ORIGIN } });
    const reading = api.workItem('qits-617');
    await settle();
    const request = http.expectOne(`${PROJECTS_ORIGIN}/projects/api/work/qits-617`);
    expect(request.request.withCredentials).toBe(true);
    request.flush({ id: 'uuid-1', archetype: 'TICKET', projectId: 'p1', qualifiedId: 'qits-617' });
    await expect(reading).resolves.toMatchObject({ id: 'uuid-1', archetype: 'TICKET' });
  });
});
