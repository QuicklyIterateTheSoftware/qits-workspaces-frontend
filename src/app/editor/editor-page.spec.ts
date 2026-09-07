import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  QITS_SCOPE,
  provideQitsRepositoryList,
  type QitsScope,
  type QitsScopeSource,
  QITS_NAVIGATION,
  type QitsNavigationSource,
  type QitsNavTree,
} from '@qits/ui-components';
import type { EditorSessionDto } from '../api/dto';
import { routes } from '../app.routes';
import { EditorPage } from './editor-page';
import { BROWSER_LOCATION, type BrowserLocation } from './editor-origin';

/**
 * The waiting room: one idempotent door, polled, and then a full navigation out of the application.
 *
 * **The negatives are the tests worth having.** Nothing is deleted on the way out, because the
 * editor rides a container somebody else may be working in — the same rule the glances page states
 * about its shared session. Nothing is navigated to before the service says the editor answers,
 * because a hand-off to an origin that is not up yet is a browser error page with no way back. Both
 * are silent when they regress: a page that tore the container down on leave, or one that
 * handed off a second early, looks identical in every screenshot.
 */
describe('EditorPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<EditorPage>;
  let assigned: string[];

  const ENSURE_URL = '/workspaces/api/editor/ensure?repositoryId=qits-qits';

  const session = (over: Partial<EditorSessionDto> = {}): EditorSessionDto => ({
    workspaceId: '7',
    containerStatus: 'RUNNING',
    editorState: 'STARTING',
    editorReady: false,
    ...over,
  });

  /** A scope stated outright, the way the URL would have stated it. */
  const scopeSource = (scope: QitsScope): Provider => {
    const source: QitsScopeSource = {
      scope: signal(scope),
      projectId: signal(scope.project ? 'p1' : undefined),
      repositoryId: signal(scope.repository ? 'qits-ci' : undefined),
      routing: 'repository',
      select: () => undefined,
    };
    return { provide: QITS_SCOPE, useValue: source };
  };

  /** The browser, as a fake: a hand-off that records instead of leaving. */
  const browser: BrowserLocation = {
    hostname: () => 'workspaces.wohlben.eu',
    assign: (url: string) => void assigned.push(url),
  };

  /**
   * The navigation document, as the shell would hold it: the platform's origin statements and
   * nothing else. Both are set and they differ, which is what makes the assertions below say which
   * one the page composes against — `projectOrigin`, the one that always spells the environment
   * label, because the editor is a four-label host.
   *
   * `projectOrigin` is cast in for the same reason the page widens it: the edge serves the field,
   * the typed one lands with the next @qits/ui-components release.
   */
  const navigationSource: QitsNavigationSource = {
    tree: signal({
      entries: [],
      projectOrigin: 'https://dev.wohlben.eu',
      environmentOrigin: 'https://wohlben.eu',
      apiDocs: {},
      legacy: undefined,
    } as QitsNavTree),
    failed: signal(false),
  };

  function configure(scope: Provider): void {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        // The chrome's answer for the scoped project: the wrapper is the row the editor rides.
        provideQitsRepositoryList(
          [{ id: 'qits-ci', name: 'qits-ci', category: 'services' }],
          'qits-qits',
        ),
        { provide: BROWSER_LOCATION, useValue: browser },
        // The platform's statement of the environment's own authority — what the hand-off's
        // address is composed from, exactly as the sidebar composes every cross-app link.
        { provide: QITS_NAVIGATION, useValue: navigationSource },
        scope,
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EditorPage);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    assigned = [];
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  /** Let the request chain land, then render. One turn regularly returns mid-chain. */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function press(label: string): Promise<void> {
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const target = buttons.find((button) => (button.textContent ?? '').includes(label));
    expect(target, `no button reading “${label}”`).toBeTruthy();
    target?.click();
    await settle();
  }

  /** Open the page under a project and answer the door once. */
  async function open(answer: EditorSessionDto = session()): Promise<void> {
    configure(scopeSource({ project: 'qits' }));
    await settle();
    http.expectOne(ENSURE_URL).flush(answer);
    await settle();
  }

  it('asks the door on entry, once, scoped to the project’s wrapper repository', async () => {
    configure(scopeSource({ project: 'qits' }));
    await settle();

    const request = http.expectOne(ENSURE_URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    request.flush(session());
    await settle();
  });

  it('asks for the project’s wrapper even where the address names a repository', async () => {
    // The editor is one per project and rides the aggregate workspace; the repository segment says
    // which page the reader came in through, not which editor this is.
    configure(scopeSource({ project: 'qits', group: 'qits-ci', repository: 'qits-ci' }));
    await settle();

    http.expectOne(ENSURE_URL).flush(session());
    await settle();
  });

  it('waits rather than navigating while the editor is not ready, and asks again in two seconds', async () => {
    await open(session({ containerStatus: 'PROVISIONING', editorState: null }));

    expect(assigned).toEqual([]);
    expect(text()).toContain('Starting the container');
    expect(text()).toContain('https://editor.qits.dev.wohlben.eu/');

    vi.advanceTimersByTime(2_000);
    http.expectOne(ENSURE_URL).flush(session());
    await settle();

    expect(assigned).toEqual([]);
    expect(text()).toContain('Starting the editor…');
  });

  it('hands off with a full navigation once — and only once — the door reports it ready', async () => {
    await open();
    expect(assigned).toEqual([]);

    vi.advanceTimersByTime(2_000);
    http.expectOne(ENSURE_URL).flush(session({ editorState: 'RUNNING', editorReady: true }));
    await settle();

    expect(assigned).toEqual(['https://editor.qits.dev.wohlben.eu/']);

    // The poll is over: a ready editor is asked for nothing more.
    vi.advanceTimersByTime(10_000);
    await settle();
  });

  it('deletes nothing on the way out — the editor rides a container somebody else is in', async () => {
    await open();

    fixture.destroy();
    vi.advanceTimersByTime(10_000);

    expect(http.match(() => true)).toEqual([]);
  });

  it('says an ended session ended, stops asking, and offers the press that starts a new one', async () => {
    await open(session({ editorState: 'ENDED' }));

    expect(text()).toContain('editor session ended');

    // An ended editor does not come back on its own, so nothing is polled for.
    vi.advanceTimersByTime(10_000);
    await settle();

    await press('Start it again');
    http.expectOne(ENSURE_URL).flush(session());
    await settle();

    expect(text()).toContain('Starting the editor…');
  });

  it('reports a refused door in the service’s words, with a Retry that asks again', async () => {
    configure(scopeSource({ project: 'qits' }));
    await settle();
    http
      .expectOne(ENSURE_URL)
      .flush({ message: 'no wrapper workspace' }, { status: 503, statusText: 'Unavailable' });
    await settle();

    expect(text()).toContain('Could not start the editor — 503 no wrapper workspace');

    await press('Retry');
    http.expectOne(ENSURE_URL).flush(session());
    await settle();
  });

  it('stops the container, and stops asking for one — the door would start it again', async () => {
    await open();

    await press('Stop');
    const stop = http.expectOne('/workspaces/api/workspaces/7/stop-container');
    expect(stop.request.method).toBe('POST');
    stop.flush({ id: 7 });
    await settle();

    expect(text()).toContain('The container is stopped');
    vi.advanceTimersByTime(10_000);
    await settle();

    await press('Start the editor');
    http.expectOne(ENSURE_URL).flush(session());
    await settle();
  });

  it('recreates the container and picks the wait back up', async () => {
    await open();

    await press('Recreate');
    http
      .expectOne('/workspaces/api/workspaces/7/recreate-container')
      .flush({ workspace: { id: 7 }, technicalProcessId: 'p-1' });
    await settle();

    vi.advanceTimersByTime(2_000);
    http.expectOne(ENSURE_URL).flush(session());
    await settle();
  });

  it('reads the recreate guard’s 400 as a sentence rather than as a status', async () => {
    await open();

    await press('Recreate');
    http
      .expectOne('/workspaces/api/workspaces/7/recreate-container')
      .flush(
        { message: 'workspace 7 has uncommitted changes' },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle();

    expect(text()).toContain('working tree the service can prove is clean');
    expect(text()).toContain('workspace 7 has uncommitted changes');

    // The wait goes on: a refused recreate changed nothing about the editor coming up.
    vi.advanceTimersByTime(2_000);
    http.expectOne(ENSURE_URL).flush(session());
    await settle();
  });

  it('asks for nothing at all with no project scoped, and says which address would have one', async () => {
    configure(scopeSource({}));
    await settle();

    expect(text()).toContain('/<project>/editor');
    vi.advanceTimersByTime(10_000);
    await settle();
  });
});
