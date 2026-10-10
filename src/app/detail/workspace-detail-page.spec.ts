import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import type { AgentDto, WorkspaceDto } from '../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../api/event-source';
import { routes } from '../app.routes';

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
  id: 'qits-qits',
  name: 'qits-qits',
  backupUrl: 'https://example.invalid/qits-qits.git',
  mainBranch: 'main',
  archetype: 'WRAPPER',
  projectId: 'p1',
};

const workspace = (id: number, over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id,
  workspaceId: `ws-${id}`,
  parent: null,
  branch: null,
  ahead: null,
  behind: null,
  conflictsWithParent: false,
  status: 'ACTIVE',
  runtimeStatus: 'RUNNING',
  runtimeError: null,
  clean: null,
  agentActivity: null,
  preamble: null,
  result: null,
  resolvedAt: null,
  daemonConnectedAt: '2026-08-01T09:00:00Z',
  daemonVersion: '1.4.0',
  daemonBuildTime: null,
  daemonOutdated: null,
  placement: 'RUNNER',
  runner: { id: 'r1', name: 'box-1' },
  ...over,
});

const agent = (agentId: string, over: Partial<AgentDto> = {}): AgentDto => ({
  agentId,
  workspaceRowId: 7,
  repositoryId: 'qits-qits',
  workId: `work-${agentId}`,
  entityId: 'qits-617',
  entityTitle: 'Fix the login',
  wrapperBranch: 'ticket/qits-617',
  branches: [],
  state: 'ACTIVE',
  runState: 'RUNNING',
  admin: false,
  activity: 'BUSY',
  ...over,
});

/**
 * The workspace page: a slot and the agents it hosts (qits-1152). What it costs to open, what it
 * shows, and the record it shows for a workspace that has resolved.
 */
describe('WorkspaceDetailPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let streams: FakeStream[];

  const REPOSITORY_URL = '/projects/api/repositories/qits-qits';

  beforeEach(async () => {
    streams = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
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

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  function element(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  /** Open the page and answer its four reads. `null` answers the workspace read with a 404. */
  async function open(
    url = '/repositories/qits-qits/workspaces/7',
    row: WorkspaceDto | null = workspace(7),
    agents: readonly AgentDto[] = [],
    processId: string | null = null,
  ): Promise<void> {
    await harness.navigateByUrl(url);
    const id = Number(url.split('/workspaces/')[1].split('?')[0]);
    http.expectOne(REPOSITORY_URL).flush({ repository: REPOSITORY });
    const read = http.expectOne(`/workspaces/api/workspaces/${id}`);
    if (row) {
      read.flush({ workspace: row });
    } else {
      read.flush({ message: 'Workspace not found' }, { status: 404, statusText: 'Not Found' });
    }
    http.expectOne((request) => request.url === '/workspaces/api/agents').flush({ agents });
    http
      .expectOne((request) => request.url.endsWith('/active-process'))
      .flush({ technicalProcessId: processId });
    await settle();
  }

  it('reads four things and opens one stream, and nothing else', async () => {
    await open();
    expect(streams.map((stream) => stream.url)).toEqual(['/workspaces/api/workspaces/7/events']);
    http.verify();
  });

  it('asks for the agents of this workspace only', async () => {
    await harness.navigateByUrl('/repositories/qits-qits/workspaces/7');
    http.expectOne(REPOSITORY_URL).flush({ repository: REPOSITORY });
    http.expectOne('/workspaces/api/workspaces/7').flush({ workspace: workspace(7) });
    const agents = http.expectOne((request) => request.url === '/workspaces/api/agents');
    expect(agents.request.params.get('workspaceId')).toBe('7');
    agents.flush({ agents: [] });
    http.expectOne((request) => request.url.endsWith('/active-process')).flush({});
    await settle();
  });

  it('draws the slot: label, wrapper, runner and container', async () => {
    await open();
    const text = element().textContent ?? '';
    expect(text).toContain('Workspace ws-7');
    expect(text).toContain('qits-qits');
    expect(text).toContain('on runner box-1');
    expect(element().querySelector('app-status-strip')).not.toBeNull();
  });

  it('marks an admin slot', async () => {
    await open(undefined, workspace(7, { admin: true, placement: 'DIRECT', runner: null }));
    expect(element().textContent).toContain('docker socket');
    expect(element().textContent).toContain('on the platform host');
  });

  it('lists its agents, each linked to its own page, with state and branches', async () => {
    await open(undefined, workspace(7), [
      agent('a1', {
        branches: [
          { repositoryId: 'qits-ci', branch: 'ticket/qits-617-fix' },
          { repositoryId: 'qits-qits', branch: 'ticket/qits-617' },
        ],
      }),
      agent('a2', { entityId: 'qits-618', runState: 'YIELDED', activity: null, admin: true }),
    ]);

    const rows = Array.from(element().querySelectorAll('.agent-list .agent'));
    expect(rows).toHaveLength(2);
    const link = rows[0].querySelector('a.agent-name') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/agents/a1');
    expect(rows[0].textContent).toContain('qits-617');
    expect(rows[0].textContent).toContain('Fix the login');
    expect(rows[0].textContent).toContain('working');
    expect(rows[0].textContent).toContain('ticket/qits-617-fix');
    // The wrapper branch is drawn once, not again as a pushed branch.
    expect(rows[0].textContent?.match(/ticket\/qits-617(?!-)/g)).toHaveLength(1);
    expect(rows[1].textContent).toContain('yielded');
    expect(rows[1].textContent).toContain('admin');
  });

  it('leaves removed agents out', async () => {
    await open(undefined, workspace(7), [agent('a1'), agent('a2', { state: 'REMOVED' })]);
    expect(element().querySelectorAll('.agent-list .agent')).toHaveLength(1);
  });

  it('says so when the slot hosts no agent', async () => {
    await open();
    expect(element().querySelector('app-empty')?.textContent).toContain(
      'No agent is in this workspace',
    );
  });

  it('has no tabs, no integrate and no discard: those belong to agents now', async () => {
    await open();
    expect(element().querySelector('app-tab-host')).toBeNull();
    expect(element().textContent).not.toContain('Integrate');
    expect(element().textContent).not.toContain('Discard');
  });

  it('shows the start process while one runs', async () => {
    await open(undefined, workspace(7), [], 'proc-1');
    expect(element().querySelector('.starting app-starting-panel')).not.toBeNull();
  });

  it('re-reads its agents on an agents hint', async () => {
    await open();
    streams[0].onmessage?.(new MessageEvent<string>('message', { data: 'agents' }));
    await settle();
    http.expectOne('/workspaces/api/workspaces/7').flush({ workspace: workspace(7) });
    http
      .expectOne((request) => request.url === '/workspaces/api/agents')
      .flush({ agents: [agent('a1')] });
    await settle();
    expect(element().querySelectorAll('.agent-list .agent')).toHaveLength(1);
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
    url = '/repositories/qits-qits/workspaces/9',
  ): Promise<void> {
    await open(url, null);
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
    expect(element().querySelector('.agents')).toBeNull();
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

  it('says a runner-placed workspace has no archived transcripts, instead of an empty list', async () => {
    await openResolved([], { placement: 'RUNNER' });

    const empty = element().querySelector('app-empty')?.textContent ?? '';
    expect(empty).toContain('Archived transcripts are not available for runner-placed workspaces');
    expect(empty).not.toContain('No agent sessions could be read');
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
      '/repositories/qits-qits/workspaces/9?session=s-1',
    );

    http
      .expectOne(`${SESSIONS_URL}/s-1/transcript`)
      .flush({ lines: [JSON.stringify({ type: 'user', text: 'linked straight here' })] });
    await settle();

    expect(element().querySelector('.replay')?.textContent).toContain('linked straight here');
  });

  it('says so plainly when there is no such workspace, live or resolved', async () => {
    await open('/repositories/qits-qits/workspaces/9', null);

    http
      .expectOne('/workspaces/api/history/9')
      .flush({ message: 'Workspace not found: 9' }, { status: 404, statusText: 'Not Found' });
    http
      .expectOne(SESSIONS_URL)
      .flush({ message: 'Workspace not found: 9' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(element().textContent).toContain('No such workspace here');
  });
});
