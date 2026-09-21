import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import type { WorkspaceDto } from '../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../api/event-source';
import { routes } from '../app.routes';
import { WorkspaceDetailPage } from './workspace-detail-page';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
}

const REPOSITORY = {
  id: 'qits-ci',
  name: 'qits-ci',
  backupUrl: 'https://example.invalid/qits-ci.git',
  mainBranch: 'main',
  archetype: 'SERVICE',
  projectId: 'p1',
};

const workspace = (id: number, label: string, over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id,
  workspaceId: label,
  parent: 'main',
  branch: `task/${label}`,
  ahead: 1,
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
  daemonConnectedAt: '2026-08-01T09:00:00Z',
  daemonVersion: '1.4.0',
  daemonBuildTime: null,
  daemonOutdated: null,
  ...over,
});

/**
 * The shell: what it costs to open, what the URL means, and what it refuses to open at all.
 *
 * **The load budget is asserted, not just written down.** A budget that lives only in a comment grows
 * a fourth request the first time somebody needs one, and nobody notices until an idle workspace is
 * making traffic. Three reads and one stream, named, in a test that fails the moment a fourth appears
 * — and the same three sentences are on the component, so the two have to move together.
 *
 * **A tab change reuses the page and a workspace change does not.** Angular reuses a component across
 * a path-parameter change, which is right for one and a bug for the other: the page reads its
 * identity into a dozen signals and a live channel, and a reused instance would go on showing the
 * previous workspace.
 *
 * **A resolved workspace does not get a detail view.** It is not in the active list at all, its
 * container is gone, and six tabs that every one of them 502s would be worse than an honest record.
 */
describe('WorkspaceDetailPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let streams: FakeStream[];

  const REPOSITORY_URL = '/projects/api/repositories/qits-ci';
  const WORKSPACES_URL = '/workspaces/api/workspaces?repositoryId=qits-ci';
  const ACTIVE_PROCESS_URL = '/workspaces/api/workspaces/7/active-process';

  beforeEach(async () => {
    streams = [];
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
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const stream = new FakeStream(url);
            streams.push(stream);
            return stream;
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  /** Let the request chain land, then render. One `whenStable` can return mid-chain. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  function element(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function page(): WorkspaceDetailPage {
    return harness.fixture.debugElement.query(By.directive(WorkspaceDetailPage))
      .componentInstance as WorkspaceDetailPage;
  }

  function tabs(): HTMLButtonElement[] {
    return Array.from(element().querySelectorAll('.strip .tab'));
  }

  /** Open the page and answer its three reads. */
  async function open(
    url = '/repositories/qits-ci/workspaces/7',
    workspaces: readonly WorkspaceDto[] = [workspace(7, 'widgets')],
    processId: string | null = null,
  ): Promise<void> {
    await harness.navigateByUrl(url);
    http.expectOne(REPOSITORY_URL).flush({ repository: REPOSITORY });
    http
      .expectOne(WORKSPACES_URL)
      .flush({ entries: workspaces.map((entry) => ({ workspace: entry })) });
    http
      .expectOne((request) => request.url.endsWith('/active-process'))
      .flush({ technicalProcessId: processId });
    await settle();
    await answerChatPanel();
  }

  /**
   * The Chat panel's own budget, paid on every open because Chat is the tab a bare URL selects — the
   * `T` in the page's `3 + T`. The container's command list, then the saved draft once the list has
   * said nothing is running.
   */
  async function answerChatPanel(): Promise<void> {
    for (const request of http.match((candidate) => candidate.url.endsWith('/commands'))) {
      request.flush({ entries: [] });
    }
    await settle();
    for (const request of http.match((candidate) => candidate.url.endsWith('/prompt-draft'))) {
      request.flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    }
    await settle();
  }

  /**
   * The Files panel's own budget, paid the first time its tab is selected and never again — the `T`
   * in the page's `3 + T`. Two reads of one workspace's container: the whole eager tree, and the
   * detection that gates the framework footer.
   */
  function answerFilesPanel(workspaceRowId = 7): void {
    http
      .expectOne(`/workspaces/container/${workspaceRowId}/files`)
      .flush({ paths: [], lazyDirs: [], generation: 'gen-1' });
    http
      .expectOne(`/workspaces/container/${workspaceRowId}/detection`)
      .flush({ projects: [], frameworks: [], links: [], generation: 'gen-1' });
  }

  it('reads three things and opens one stream, and nothing else', async () => {
    await harness.navigateByUrl('/repositories/qits-ci/workspaces/7');

    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.urlWithParams).sort()).toEqual(
      [ACTIVE_PROCESS_URL, REPOSITORY_URL, WORKSPACES_URL].sort(),
    );
    expect(streams.map((stream) => stream.url)).toEqual(['/workspaces/api/workspaces/7/events']);

    for (const request of requests) {
      if (request.request.url === REPOSITORY_URL) {
        request.flush({ repository: REPOSITORY });
      } else if (request.request.url.endsWith('/active-process')) {
        request.flush({ technicalProcessId: null });
      } else {
        request.flush({ entries: [{ workspace: workspace(7, 'widgets') }] });
      }
    }
    await settle();
    await answerChatPanel();
  });

  it('draws the workspace, its branch and where it was forked from', async () => {
    await open();

    expect(element().textContent).toContain('widgets');
    expect(element().textContent).toContain('task/widgets');
    expect(element().textContent).toContain('forked from');
  });

  it('selects the first tab for a bare URL, and does not write the slug into it', async () => {
    await open();

    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Chat');
  });

  it('puts the chosen tab in the URL, so every tab is a link', async () => {
    await open();
    const files = tabs().find((tab) => tab.textContent?.trim() === 'Files')!;

    files.click();
    await settle();
    // Selecting a tab that has never been opened costs that tab's requests, which is exactly why the
    // tab is in the URL: it is expensive state, so it is addressable state.
    answerFilesPanel();
    await settle();

    expect(TestBed.inject(Location).path()).toContain('tab=files');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Files');
  });

  it('normalises an unknown slug away rather than obeying it', async () => {
    await open('/repositories/qits-ci/workspaces/7?tab=sketch');
    await settle();

    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
  });

  it('reuses the page across a tab change and rebuilds it across a workspace change', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets'),
      workspace(8, 'other'),
    ]);
    const detail = page();
    expect(detail.remounts()).toBe(0);

    await harness.navigateByUrl('/repositories/qits-ci/workspaces/7?tab=files');
    await settle();
    answerFilesPanel(7);
    await settle();
    expect(detail.remounts()).toBe(0);

    // A move within one repository re-reads the process lookup and nothing else: the list already
    // holds every workspace in the repository, and re-asking for it would be a second copy.
    await harness.navigateByUrl('/repositories/qits-ci/workspaces/8?tab=files');
    http
      .expectOne((request) => request.url.endsWith('/8/active-process'))
      .flush({ technicalProcessId: null });
    await settle();
    // The remount tore the panel down with the rest of the subtree, so it reads the new container.
    answerFilesPanel(8);
    await settle();
    await answerChatPanel();

    expect(detail.remounts()).toBe(1);
    expect(element().textContent).toContain('task/other');
  });

  const SESSIONS_URL = '/workspaces/api/history/9/agent-sessions';

  const agentSession = (sessionId: string, over: Record<string, unknown> = {}) => ({
    sessionId,
    startedAt: '2026-07-31T21:00:00Z',
    endedAt: '2026-07-31T21:29:00Z',
    messageCount: 12,
    subagents: [],
    ...over,
  });

  /**
   * The resolved page's own budget: the history record **and** the agent sessions, both read from
   * the host and both asked exactly once. A test that answered only the record would leave the
   * second request outstanding and `http.verify()` would say so — which is the point of flushing it
   * here rather than loosening the verify.
   */
  async function openResolved(
    sessions: readonly unknown[] = [],
    record: Record<string, unknown> = {},
    url = '/repositories/qits-ci/workspaces/9',
  ): Promise<void> {
    await open(url, [workspace(7, 'widgets')]);
    http.expectOne('/workspaces/api/history/9').flush({
      workspace: {
        id: 9,
        workspaceId: 'old-work',
        parent: 'main',
        status: 'INTEGRATED',
        preamble: null,
        result: 'integrate(main): the thing',
        createdAt: '2026-07-31T21:32:23Z',
        resolvedAt: '2026-07-31T21:32:35Z',
        events: [],
        ...record,
      },
    });
    http.expectOne(SESSIONS_URL).flush({ sessions });
    await settle();
  }

  function sessionRows(): HTMLElement[] {
    return Array.from(element().querySelectorAll('.sessions .session'));
  }

  it('does not open a resolved workspace — it shows the record and says why', async () => {
    await openResolved();

    expect(element().textContent).toContain('old-work');
    expect(element().textContent).toContain('the work is finished');
    expect(element().querySelector('app-tab-host')).toBeNull();
  });

  /**
   * The whole point of the screen. The container is gone, so the daemon proxy answers 404 for every
   * call about it; the host kept the sessions, and a reader who wants to know why the diff looks the
   * way it does has nowhere else to look.
   */
  it('lists the agent sessions that ran in a resolved workspace', async () => {
    await openResolved([
      agentSession('s-refine', { messageCount: 31 }),
      agentSession('s-implement', {
        startedAt: '2026-07-31T21:30:00Z',
        endedAt: null,
        messageCount: 169,
        subagents: [
          { agentId: 'a-1', agentType: 'Explore', description: 'find the seam', messageCount: 42 },
        ],
      }),
    ]);

    const rows = sessionRows();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('31 messages');
    expect(rows[1].textContent).toContain('169 messages');
    // A sub-agent is summarised on the row that spawned it, so the pick is informed before the
    // transcript is paid for.
    expect(rows[1].textContent).toContain('Explore');
    expect(rows[1].textContent).toContain('find the seam');
    // A session that never wrote an ending says so rather than inventing a close time.
    expect(rows[1].textContent).toContain('—');
  });

  /**
   * An empty list is an answer and not a failure, so it must not be drawn as an error — that would
   * send a reader looking for a fault that is not present.
   *
   * And it must not be drawn as "no agent ran" either, which is the stronger claim the wire does not
   * support: an empty list is the common answer while the transcript volume is unmounted on the
   * service, so a workspace that ran several sessions answers with none. The assertion below is on
   * the weaker sentence *and* on the absence of the stronger one, because the failure mode here is a
   * later edit quietly tightening the wording back into a lie.
   */
  it('says only that no sessions could be read — never that none ran', async () => {
    await openResolved([]);

    const empty = element().querySelector('app-empty')?.textContent ?? '';
    expect(empty).toContain('No agent sessions could be read');
    expect(empty).toContain('not the same as none having run');
    expect(empty).not.toContain('ever ran');
    expect(element().querySelector('.async-error')).toBeNull();
  });

  /**
   * A transcript is the expensive read on this screen and is never made speculatively — which is
   * also why the selection is in the URL rather than in a signal.
   */
  it('fetches no transcript until a session is picked', async () => {
    await openResolved([agentSession('s-1')]);

    http.expectNone((request) => request.url.includes('/transcript'));
  });

  /**
   * Picked, fetched, and drawn by the live chat's own renderer — the lines are the shape the chat
   * socket carries, so the record and the live view cannot disagree about a conversation.
   */
  it('opens the picked session and renders its conversation', async () => {
    await openResolved([agentSession('s-1'), agentSession('s-2')]);

    (sessionRows()[0].querySelector('.pick') as HTMLButtonElement).click();
    await settle();

    expect(TestBed.inject(Location).path()).toContain('session=s-1');
    http.expectOne(`${SESSIONS_URL}/s-1/transcript`).flush({
      lines: [
        JSON.stringify({ type: 'user', text: 'make it faster' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'the export is the hot loop' }] },
        }),
      ],
    });
    await settle();

    const replay = element().querySelector('.replay');
    expect(replay?.textContent).toContain('make it faster');
    expect(replay?.textContent).toContain('the export is the hot loop');
  });

  /** A different pick is a different conversation: the old one goes before the new one arrives. */
  it('refetches the transcript when another session is picked', async () => {
    await openResolved([agentSession('s-1'), agentSession('s-2')]);

    (sessionRows()[0].querySelector('.pick') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne(`${SESSIONS_URL}/s-1/transcript`)
      .flush({ lines: [JSON.stringify({ type: 'user', text: 'the first one' })] });
    await settle();

    (sessionRows()[1].querySelector('.pick') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne(`${SESSIONS_URL}/s-2/transcript`)
      .flush({ lines: [JSON.stringify({ type: 'user', text: 'the second one' })] });
    await settle();

    expect(element().textContent).toContain('the second one');
    expect(element().textContent).not.toContain('the first one');
  });

  /** A deep link lands on the conversation, not merely on the list it is in. */
  it('opens the session named in the URL on load', async () => {
    await openResolved(
      [agentSession('s-1')],
      {},
      '/repositories/qits-ci/workspaces/9?session=s-1',
    );

    http
      .expectOne(`${SESSIONS_URL}/s-1/transcript`)
      .flush({ lines: [JSON.stringify({ type: 'user', text: 'linked straight here' })] });
    await settle();

    expect(element().querySelector('.replay')?.textContent).toContain('linked straight here');
  });

  /**
   * A dispatched workspace names its subject in a field and carries no goal, so the header says what
   * it is for instead of quoting a ticket that has moved on since.
   *
   * The link itself is not asserted here: composing one needs the platform's navigation document and
   * a project in the address, and these specs run unscoped with neither. That absence IS a case —
   * the reference still has to say what the workspace is about — so what is pinned is the label, and
   * `workspace-subject.spec` pins the address the label is linked to.
   */
  it('shows a dispatched workspace its reference instead of a goal', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets', { branch: 'ticket/fix-login', ticketId: 't-1', preamble: null }),
    ]);

    const subject = element().querySelector('.subject');
    expect(subject?.textContent?.trim()).toBe('Ticket fix-login');
    expect(element().querySelector('.preamble')).toBeNull();
  });

  /**
   * The other half, and the reason the prose was not simply deleted: a workspace a person created
   * by hand states its scope in a preamble, and so does every workspace that predates the fields.
   */
  it('keeps the prose goal of a workspace nobody dispatched', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets', { preamble: 'Speed up the export' }),
    ]);

    expect(element().querySelector('.preamble')?.textContent).toContain('Speed up the export');
    expect(element().querySelector('.subject')).toBeNull();
  });

  it('says so plainly when there is no such workspace, live or resolved', async () => {
    await open('/repositories/qits-ci/workspaces/9', [workspace(7, 'widgets')]);

    http
      .expectOne('/workspaces/api/history/9')
      .flush({ message: 'Workspace not found: 9' }, { status: 404, statusText: 'Not Found' });
    // The sessions read goes out beside the record rather than behind it — the two are independent
    // host reads — so an id that is nowhere fails both, and both have to be answered here.
    http
      .expectOne(SESSIONS_URL)
      .flush({ message: 'Workspace not found: 9' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(element().textContent).toContain('No such workspace here');
  });

  it('grows the transient tab when a process is running, pinned to the front and selected', async () => {
    await open('/repositories/qits-ci/workspaces/7', [workspace(7, 'widgets')], 'proc-1');

    expect(tabs()[0].textContent?.trim()).toBe('Starting');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Starting');
    // The transient tab is deliberately not in the URL: it unmounts, and a link to it lands nowhere.
    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
  });

  it('shows every workspace with agent activity, not only this one', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets', { agentActivity: 'BUSY' }),
      workspace(8, 'other', { agentActivity: 'WAITING' }),
      workspace(9, 'quiet'),
    ]);

    const entries = Array.from(element().querySelectorAll('.bar .entry .name')).map(
      (node) => (node as HTMLElement).textContent,
    );

    expect(entries).toEqual(['task/widgets', 'task/other']);
  });
});
