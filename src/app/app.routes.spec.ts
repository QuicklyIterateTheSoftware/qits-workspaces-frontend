import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, UrlSegment, provideRouter, type Route } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { QITS_CATEGORIES, provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './api/event-source';
import { isRepositoryAddress, routes } from './app.routes';
import { WorkspaceDetailPage } from './detail/workspace-detail-page';
import { EditorPage } from './editor/editor-page';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './overview/workspaces-page';
import { RunnersPage } from './runners/runners-page';

/**
 * One page, three spellings of every address.
 *
 * This application is served at the root of its own host, so `/repositories/r1/workspaces/12`,
 * `/qits/repositories/r1/workspaces/12` and `/qits/qits-ci/qits-ci-service/repositories/r1/…` are
 * the same workspace seen unscoped, under a project and under the repository the reader came in
 * through. All three have to reach the same component. The middle segment is the repository's
 * group, spelled as its component or as its archetype category; both resolve.
 *
 * The trap the guard exists for is the other direction: `repositories` is neither a project slug
 * nor a group, and without `canMatch` the repository branch would claim this application's own
 * three leading segments as a project, a group and a repository.
 */
describe('routes', () => {
  let harness: RouterTestingHarness;

  /** The detail page opens a stream on arrival, and jsdom has no `EventSource`. */
  const noStream: EventSourceLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    readyState: 1,

    close: () => undefined,
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsRepositoryList([]),
        provideQitsScope('repository'),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => noStream },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  /**
   * The component the URL activated. The harness hands back the component of the route it mounted,
   * which here is always the layout; the page is the leaf below it.
   */
  async function activated(url: string): Promise<unknown> {
    await harness.navigateByUrl(url);
    let route = TestBed.inject(Router).routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.component;
  }

  it('serves the overview bare', async () => {
    expect(await activated('/')).toBe(WorkspacesPage);
  });

  it('serves the overview under a repository', async () => {
    expect(await activated('/qits/services/qits-ci')).toBe(WorkspacesPage);
  });

  it('serves the editor in all three spellings', async () => {
    // One page per project, and the project is the scope rather than a parameter — so the same
    // component answers bare, under a project and under a repository.
    expect(await activated('/editor')).toBe(EditorPage);
    expect(await activated('/qits/editor')).toBe(EditorPage);
    expect(await activated('/qits/qits-ci/qits-ci-service/editor')).toBe(EditorPage);
  });

  it('never reads its own `editor` segment as a project', async () => {
    // `/editor/qits-ci/qits-ci-service` would otherwise be a project called `editor`.
    expect(await activated('/editor/qits-ci/qits-ci-service')).toBe(NotFound);
  });

  it('serves the runners page bare and under a project', async () => {
    expect(await activated('/runners')).toBe(RunnersPage);
    expect(await activated('/qits/runners')).toBe(RunnersPage);
  });

  it('never reads its own `runners` segment as a project', async () => {
    // `/runners/qits-ci/qits-ci-service` would otherwise be a project called `runners`.
    expect(await activated('/runners/qits-ci/qits-ci-service')).toBe(NotFound);
    const segments = ['runners', 'qits-ci', 'qits-ci-service'].map(
      (path) => new UrlSegment(path, {}),
    );
    expect(isRepositoryAddress({} as Route, segments)).toBe(false);
  });

  it('serves a workspace bare', async () => {
    expect(await activated('/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('serves the same workspace under a repository', async () => {
    expect(await activated('/qits/services/qits-ci/repositories/r1/workspaces/12')).toBe(
      WorkspaceDetailPage,
    );
  });

  it('lets its own literal segments win over the scoped form', async () => {
    // `repositories` would otherwise read as a project slug and `r1` as a category.
    expect(await activated('/repositories/r1/nope')).toBe(NotFound);
  });

  it('serves the overview under a project', async () => {
    // Where the chrome's project picker sends this app when a reader picks `qits`.
    expect(await activated('/qits')).toBe(WorkspacesPage);
  });

  it('serves a workspace under a project', async () => {
    expect(await activated('/qits/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('lets its own literal segments win over the project form', async () => {
    // `/repositories/r1/workspaces/12` is this app's detail page, never a project called
    // `repositories`.
    expect(await activated('/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('serves the overview under a repository addressed by its component', async () => {
    expect(await activated('/qits/qits-ci/qits-ci-service')).toBe(WorkspacesPage);
  });

  it('serves the same workspace under a repository addressed by its component', async () => {
    expect(await activated('/qits/qits-ci/qits-ci-service/repositories/r1/workspaces/12')).toBe(
      WorkspaceDetailPage,
    );
  });

  it('serves every group, whichever way the platform names it', async () => {
    // The six categories are closed; a component is not, so the guard lets any segment through
    // that is not one of this application's own — the chrome settles what it means.
    for (const group of [...QITS_CATEGORIES, 'qits-ci', 'qits-workspaces']) {
      expect(await activated(`/qits/${group}/qits-ci-service`)).toBe(WorkspacesPage);
    }
  });

  it('never reads a category as a project', async () => {
    // `/services/…` is a category in segment one, which no project slug can be.
    expect(await activated('/services/qits-ci/repositories')).toBe(NotFound);
  });
});
