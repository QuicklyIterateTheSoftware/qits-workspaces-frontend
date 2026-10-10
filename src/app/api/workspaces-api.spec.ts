import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspacesApi } from './workspaces-api';

/**
 * The paths, the envelopes and the request bodies, asserted once here so the page's spec can be
 * about rendering.
 *
 * The retired doors are pinned as absent: a workspace is a slot the service makes and removes
 * (qits-1152), and work goes home through a release request in qits-projects.
 *
 * These are same-origin absolute paths on purpose; the SPA is served at `/workspaces/` behind the
 * gateway that also serves `/projects/api/…`, and that is what carries the session cookie to both.
 */
describe('WorkspacesApi', () => {
  let api: WorkspacesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(WorkspacesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('scopes the workspace list by repository, which the service requires', async () => {
    const workspaces = api.workspaces('qits-ci');
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/api/workspaces' &&
        candidate.params.get('repositoryId') === 'qits-ci',
    );
    request.flush({
      entries: [{ workspace: { id: 7, workspaceId: 'explorer-grouping', status: 'ACTIVE' } }],
    });
    await expect(workspaces).resolves.toMatchObject([{ id: 7, workspaceId: 'explorer-grouping' }]);
  });

  it('unwraps an empty entry list as no workspaces, not as a crash', async () => {
    const workspaces = api.workspaces('qits-ci');
    http
      .expectOne((candidate) => candidate.url === '/workspaces/api/workspaces')
      .flush({
        entries: [],
      });
    await expect(workspaces).resolves.toEqual([]);
  });

  /**
   * The retired door, pinned as absent. qits-workspaces answers 404 on it now, and a client method
   * that outlived the route would be a button that cannot work — so the pin is on this object's
   * surface rather than on a request nobody makes.
   */
  it('has no release call at all, because that door left the service', () => {
    expect('release' in api).toBe(false);
    expect('releaseRequest' in api).toBe(false);
  });

  it('has no create, integrate, editor or bootstrap call: those doors left (qits-1152)', () => {
    for (const gone of [
      'createWorkspace',
      'integrate',
      'ensureEditor',
      'bootstrapRuns',
      'discard',
    ]) {
      expect(gone in api).toBe(false);
    }
  });

  it('reads one workspace by its row id', async () => {
    const reading = api.workspace(7);
    http
      .expectOne('/workspaces/api/workspaces/7')
      .flush({ workspace: { id: 7, workspaceId: 'ws-7', status: 'ACTIVE' } });
    await expect(reading).resolves.toMatchObject({ id: 7, workspaceId: 'ws-7' });
  });

  it('rejects with the HttpErrorResponse, so a 404 reads as resolved', async () => {
    const reading = api.workspace(7);
    http
      .expectOne('/workspaces/api/workspaces/7')
      .flush({ message: 'gone' }, { status: 404, statusText: 'Not Found' });
    await expect(reading).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});
