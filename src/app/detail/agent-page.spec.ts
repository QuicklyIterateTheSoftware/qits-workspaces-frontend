import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import type { AgentDto } from '../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../api/event-source';
import { WEB_SOCKET_FACTORY, type WebSocketLike } from '../api/web-socket';
import { routes } from '../app.routes';
import { SPEECH_RUNTIME, type SpeechRuntime } from './chat/speech-runtime';

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

class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {}
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

const NO_MICROPHONE: SpeechRuntime = {
  supported: () => false,
  capture: () => Promise.reject(new Error('no microphone in jsdom')),
};

const agent = (over: Partial<AgentDto> = {}): AgentDto => ({
  agentId: 'a1',
  workspaceRowId: 7,
  repositoryId: 'qits-qits',
  workId: 'uuid-617',
  entityId: 'qits-617',
  ticketId: 'uuid-617',
  entityTitle: 'Fix the login',
  entityStatus: 'IN_PROGRESS',
  wrapperBranch: 'ticket/qits-617',
  branches: [{ repositoryId: 'qits-ci', branch: 'ticket/qits-617-login' }],
  state: 'ACTIVE',
  runState: 'RUNNING',
  admin: false,
  harness: 'CLAUDE',
  activity: 'BUSY',
  ...over,
});

const WORKTREE = {
  agentId: 'a1',
  path: '/workspace/agents/a1/qits-qits',
  harnessRunning: true,
  commandId: 'cmd-1',
  branches: [],
  dirty: false,
  unpushed: true,
};

/** One agent's page (qits-1152): what it reads, what it shows, and the discard with its 409s. */
describe('AgentPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let streams: FakeStream[];
  let sockets: FakeSocket[];

  beforeEach(async () => {
    streams = [];
    sockets = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsRepositoryList([]),
        provideQitsScope('repository'),
        { provide: SPEECH_RUNTIME, useValue: NO_MICROPHONE },
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const stream = new FakeStream(url);
            streams.push(stream);
            return stream;
          },
        },
        {
          provide: WEB_SOCKET_FACTORY,
          useValue: (url: string) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  function element(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return element().textContent ?? '';
  }

  /** Answer whatever the Chat tab asked: the command list and the draft. */
  async function answerChat(commands: readonly unknown[] = []): Promise<void> {
    for (const request of http.match((candidate) => candidate.url.endsWith('/commands'))) {
      request.flush({ entries: commands.map((command) => ({ command })) });
    }
    await settle();
    for (const request of http.match((candidate) => candidate.url.endsWith('/prompt-draft'))) {
      request.flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    }
    await settle();
  }

  /** Open the page and answer its reads. */
  async function open(
    row: AgentDto = agent(),
    waits: object = [],
    worktree: object = WORKTREE,
  ): Promise<void> {
    await harness.navigateByUrl('/agents/a1');
    http.expectOne('/workspaces/api/agents/a1').flush(row);
    http.expectOne((request) => request.url === '/workspaces/api/agents/a1/waits').flush(waits);
    await settle();
    if (row.workspaceRowId) {
      http.expectOne('/workspaces/container/7/agent-worktrees/a1').flush(worktree);
      await settle();
    }
    await answerChat();
  }

  function press(label: string): void {
    const button = Array.from(element().querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim().startsWith(label),
    );
    if (!button) {
      throw new Error(`No button reading "${label}"`);
    }
    button.click();
  }

  it('reads the agent, its waits and its worktree, and opens its workspace’s stream', async () => {
    await open();
    expect(streams.map((stream) => stream.url)).toEqual(['/workspaces/api/workspaces/7/events']);
    http.verify();
  });

  it('says what the agent works on, where it runs and what it is doing', async () => {
    await open();

    expect(element().querySelector('h1')?.textContent).toContain('qits-617');
    expect(text()).toContain('Fix the login');
    expect(text()).toContain('running');
    expect(text()).toContain('working');
    expect(text()).toContain('ticket/qits-617-login');
    // The daemon's view of the worktree.
    expect(text()).toContain('unpushed commits');
    const workspaceLink = element().querySelector('a[href="/repositories/qits-qits/workspaces/7"]');
    expect(workspaceLink?.textContent).toContain('ws-7');
  });

  it('has the Chat, Files and Terminal tabs, and no Actions tab', async () => {
    await open();
    const labels = Array.from(element().querySelectorAll('.strip .tab')).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(labels).toEqual([expect.stringMatching(/^Chat/), 'Files', 'Terminal']);
  });

  it('shows what the agent waits on, when the service says (qits-1153)', async () => {
    await open(agent({ activity: 'WAITING' }), {
      waits: [{ id: 'w1', agentId: 'a1', label: 'release of qits-617', state: 'OPEN' }],
    });
    expect(text()).toContain('Waiting on release of qits-617');
  });

  it('attaches the Chat tab to the agent’s own chat command', async () => {
    await harness.navigateByUrl('/agents/a1');
    http.expectOne('/workspaces/api/agents/a1').flush(agent());
    http.expectOne((request) => request.url === '/workspaces/api/agents/a1/waits').flush([]);
    await settle();
    http.expectOne('/workspaces/container/7/agent-worktrees/a1').flush(WORKTREE);
    await settle();
    await answerChat([
      {
        id: 'cmd-1',
        repoId: 'r',
        workspaceId: 'w',
        branch: 'b',
        actionName: 'claude',
        status: 'RUNNING',
        interactive: false,
        kind: 'CHAT',
        launchedAt: 'T',
        agentSessions: [],
      },
    ]);

    expect(sockets.map((socket) => socket.url)).toEqual([
      expect.stringContaining('/workspaces/container/7/chat/commands/cmd-1'),
    ]);
  });

  it('reads a queued agent without a container, and says it waits for a slot', async () => {
    await open(agent({ workspaceRowId: null, runState: 'QUEUED', activity: null }));

    expect(streams).toHaveLength(0);
    http.expectNone((request) => request.url.includes('/workspaces/container/'));
    expect(text()).toContain('queued');
    expect(text()).toContain('No workspace yet');
  });

  it('discards plainly, then offers force with a warning on leftover work', async () => {
    await open();

    press('Discard…');
    await settle();
    expect(text()).toContain('Discard this agent?');
    press('Discard the agent');
    await settle();

    const plain = http.expectOne('/workspaces/api/agents/a1/discard');
    expect(plain.request.body).toEqual({ force: false });
    plain.flush(
      { message: 'qits-ci has 2 unpushed commits', code: 'AGENT_HAS_LEFTOVER_WORK' },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(text()).toContain('The agent has work that is not pushed');
    expect(text()).toContain('qits-ci has 2 unpushed commits');

    press('Discard anyway');
    await settle();
    const forced = http.expectOne('/workspaces/api/agents/a1/discard');
    expect(forced.request.body).toEqual({ force: true });
    forced.flush(agent({ state: 'REMOVED' }));
    await settle();
    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-qits/workspaces/7');
    // The workspace page now asks for its own things; that is its spec's business.
    for (const request of http.match(() => true)) {
      request.flush(null);
    }
  });

  it('names an unreachable daemon as the reason force is offered', async () => {
    await open();
    press('Discard…');
    await settle();
    press('Discard the agent');
    await settle();
    http
      .expectOne('/workspaces/api/agents/a1/discard')
      .flush(
        { message: 'The daemon does not answer', code: 'AGENT_DAEMON_UNREACHABLE' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();

    expect(text()).toContain('daemon does not answer, so nobody can check');
    press('Keep the agent');
    await settle();
    expect(text()).not.toContain('Discard anyway');
  });

  it('keeps any other discard failure an ordinary failure, with no force offered', async () => {
    await open();
    press('Discard…');
    await settle();
    press('Discard the agent');
    await settle();
    http
      .expectOne('/workspaces/api/agents/a1/discard')
      .flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    await settle();

    expect(text()).toContain('The agent was not discarded');
    expect(text()).not.toContain('Discard anyway');
  });

  it('shows a removed agent as a record, with no tabs and no discard', async () => {
    await open(agent({ state: 'REMOVED', workspaceRowId: null }));

    expect(element().querySelector('app-tab-host')).toBeNull();
    expect(text()).toContain('This agent is removed');
    expect(text()).not.toContain('Discard…');
  });
});
