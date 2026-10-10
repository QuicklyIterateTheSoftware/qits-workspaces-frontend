import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { FilesApi } from './files-api';

/**
 * The two reads the file browser is built from, and the one thing about their addressing that is
 * easy to get wrong.
 *
 * The container proxy **rewrites nothing**: `/files` on the daemon is `/workspaces/container/{id}/files`
 * from the browser, and the daemon is *told* the base path rather than deriving it. So a client that
 * helpfully normalised, or that sent `path=` on the root read, would be describing a different route
 * from the one the contract documents.
 */
describe('FilesApi', () => {
  let api: FilesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(FilesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the whole eager tree with no path at all', async () => {
    const answer = api.files(7, 'a1');
    const request = http.expectOne('/workspaces/container/7/agent-worktrees/a1/files');
    request.flush({ paths: ['src/main.ts'], lazyDirs: [], generation: 'gen-1' });

    // Absent rather than blank: the daemon reads both as "the root", and `path=` would make the
    // request that fetches everything look like a request for a directory called nothing.
    expect(request.request.urlWithParams).toBe('/workspaces/container/7/agent-worktrees/a1/files');
    expect((await answer).paths).toEqual(['src/main.ts']);
  });

  it('asks for one lazy directory by path', async () => {
    const answer = api.files(7, 'a1', 'node_modules');
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/container/7/agent-worktrees/a1/files' &&
        candidate.params.get('path') === 'node_modules',
    );
    request.flush({
      paths: ['node_modules/.package-lock.json'],
      lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
      generation: 'gen-1',
    });

    expect((await answer).lazyDirs[0].childCount).toBe(21);
  });

  it('reads the detection and its token, which is the point of it', async () => {
    const answer = api.detection(7, 'a1');
    http.expectOne('/workspaces/container/7/agent-worktrees/a1/detection').flush({
      projects: [{ root: 'webui', frameworkId: 'angular', label: 'Angular' }],
      frameworks: [
        {
          frameworkId: 'angular',
          root: 'webui',
          label: 'Angular',
          memberPaths: ['webui/src/main.ts'],
        },
      ],
      links: [],
      generation: 'gen-1',
    });

    expect((await answer).generation).toBe('gen-1');
  });

  it('reads one file by a required path, which is not how /files works', async () => {
    const answer = api.content(7, 'a1', 'service/target/build.log');
    http
      .expectOne(
        (candidate) =>
          candidate.url === '/workspaces/container/7/agent-worktrees/a1/files/content' &&
          candidate.params.get('path') === 'service/target/build.log',
      )
      .flush({ path: 'service/target/build.log', binary: false, content: 'a\nb\n' });

    expect((await answer).content).toBe('a\nb\n');
  });

  /**
   * The trap the contract names in as many words: the 2 MB cap **soft-degrades** to the binary flag
   * rather than answering 413, so the two are indistinguishable from the body. A client that read
   * this shape as "binary" would tell a user their 3 MB log is a picture.
   */
  it('gets the same shape for a binary file and for one over the cap', async () => {
    const answer = api.content(7, 'a1', 'dist/app.wasm');
    http
      .expectOne((candidate) => candidate.params.get('path') === 'dist/app.wasm')
      .flush({ path: 'dist/app.wasm', binary: true });

    const content = await answer;
    expect(content.binary).toBe(true);
    expect(content.content).toBeUndefined();
  });
});
