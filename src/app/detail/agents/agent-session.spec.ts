import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CommandDto } from '../../api/commands-api';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { WEB_SOCKET_FACTORY, WEB_SOCKET_OPEN, type WebSocketLike } from '../../api/web-socket';
import { WorkspaceCommands } from '../../api/workspace-commands';
import { AgentSession } from './agent-session';
import { AgentSignIn } from './agent-sign-in';

/** Several turns, because a client call is several awaits deep. */
const settle = async () => {
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve();
  }
};

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  close(): void {
    this.readyState = 2;
  }
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = WEB_SOCKET_OPEN;
  readonly sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

const command = (over: Partial<CommandDto> & Pick<CommandDto, 'id'>): CommandDto => ({
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: 'claude',
  status: 'RUNNING',
  interactive: true,
  kind: 'TERMINAL',
  launchedAt: '2026-08-01T10:00:00Z',
  agentSessions: [],
  ...over,
});

const session = (sessionId: string) => ({
  sessionId,
  recordedAt: '2026-08-01T10:00:00Z',
  source: 'PINNED' as const,
});

/**
 * The embedded session's resolution, which is the most consequential piece of behaviour on the page.
 *
 * The four branches are asserted **including the two that do nothing**, because the value of the
 * order is entirely in what it refuses to do: a running chat must not be joined by a second
 * attachment, and a workspace with history must not be resumed without a press. Both of those failure
 * modes are silent — they look like the page working — which is why they are tested rather than
 * written down.
 */
describe('AgentSession', () => {
  let http: HttpTestingController;
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
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
  });

  afterEach(() => http.verify());

  /** Point the service at a workspace and answer its three opening reads. */
  async function open(
    commands: readonly CommandDto[],
    sessions: readonly { sessionId: string; subagents: []; children: [] }[] = [],
  ): Promise<AgentSession> {
    const service = TestBed.inject(AgentSession);
    service.use(7);
    TestBed.tick();
    http.expectOne('/workspaces/container/7/agent-sessions').flush({ sessions });
    http
      .expectOne('/workspaces/container/7/agents/available')
      .flush({ agents: ['CLAUDE', 'KIMI'], defaultAgent: 'CLAUDE' });
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ entries: commands.map((entry) => ({ command: entry })) });
    await settle();
    TestBed.tick();
    await settle();
    return service;
  }

  /** Answer whatever a launch left in flight: the refreshed command list and lineage. */
  async function answer(commands: readonly CommandDto[]): Promise<void> {
    http
      .match('/workspaces/container/7/commands')
      .forEach((request) =>
        request.flush({ entries: commands.map((entry) => ({ command: entry })) }),
      );
    http
      .match('/workspaces/container/7/agent-sessions')
      .forEach((request) => request.flush({ sessions: [] }));
    await settle();
    TestBed.tick();
    await settle();
  }

  /** Push a fresh command list through the shared entry, the way a `commands` hint would. */
  async function refresh(commands: readonly CommandDto[]): Promise<void> {
    void TestBed.inject(WorkspaceCommands).refresh();
    await settle();
    await answer(commands);
  }

  it('1 — attaches to a running interactive agent run, wherever it was started', async () => {
    const service = await open([command({ id: 'c1', agentSessions: [session('s1')] })]);
    expect(service.branch()).toEqual({ kind: 'attached', commandId: 'c1' });
    expect(sockets[0].url).toContain('/workspaces/container/7/terminal/commands/c1');
    expect(service.liveSessionId()).toBe('s1');
    http.expectNone('/workspaces/container/7/agents');
  });

  it('2 — defers to a running chat and launches nothing, even with no session history', async () => {
    const service = await open([
      command({ id: 'chat1', kind: 'CHAT', interactive: false, status: 'RUNNING' }),
    ]);
    expect(service.branch()).toEqual({ kind: 'deferred', commandId: 'chat1' });
    expect(sockets).toHaveLength(0);
    // The collision session-pinning exists to prevent: no launch, no attach, a jump link instead.
    http.expectNone('/workspaces/container/7/agents');
  });

  it('3 — launches fresh when there is no session history at all, once', async () => {
    const service = await open([]);
    const launch = http.expectOne('/workspaces/container/7/agents');
    // No `agentType`: the automatic launch takes the container's own resolved default rather than
    // this page naming one. Only a launch a person asked for may pick a harness.
    // The surface rides every launch, automatic ones included. It is what tells this request apart
    // from the refining route's `epic.agent`, which is byte-identical in every other field.
    expect(launch.request.body).toEqual({
      scope: 'REPOSITORY',
      surface: 'workspace.agent',
      mode: 'INTERACTIVE',
    });
    // `deliverTaskPrompt` is never set: the tool it names is not implemented anywhere.
    expect(launch.request.body.deliverTaskPrompt).toBeUndefined();
    launch.flush({ command: command({ id: 'c9', agentSessions: [session('s9')] }) });
    await settle();
    http.expectOne('/workspaces/container/7/commands').flush({
      entries: [{ command: command({ id: 'c9', agentSessions: [session('s9')] }) }],
    });
    http.expectOne('/workspaces/container/7/agent-sessions').flush({ sessions: [] });
    await settle();
    TestBed.tick();
    await settle();
    expect(service.branch().kind).toBe('attached');
  });

  it('4 — idles on an explicit choice when history exists and nothing is running', async () => {
    const service = await open(
      [command({ id: 'c1', status: 'EXITED', agentSessions: [session('s1')] })],
      [{ sessionId: 's1', subagents: [], children: [] }],
    );
    expect(service.branch()).toEqual({ kind: 'idle' });
    expect(sockets).toHaveLength(0);
    // **Never automatic.** A recorded session can be gone from the agent's own state.
    http.expectNone('/workspaces/container/7/agents');
    expect(service.lastSession()?.sessionId).toBe('s1');
  });

  it('resumes only on a press, and never pairs fork with no session id', async () => {
    const service = await open(
      [command({ id: 'c1', status: 'EXITED', agentSessions: [session('s1')] })],
      [{ sessionId: 's1', subagents: [], children: [] }],
    );
    void service.resume('s1', true);
    await settle();
    const launch = http.expectOne('/workspaces/container/7/agents');
    expect(launch.request.body).toEqual({
      scope: 'REPOSITORY',
      surface: 'workspace.agent',
      mode: 'INTERACTIVE',
      resumeSessionId: 's1',
      fork: true,
    });
    launch.flush({ command: command({ id: 'c2', agentSessions: [session('s2')] }) });
    await settle();
    http.match('/workspaces/container/7/commands').forEach((request) =>
      request.flush({
        entries: [{ command: command({ id: 'c2', agentSessions: [session('s2')] }) }],
      }),
    );
    http
      .match('/workspaces/container/7/agent-sessions')
      .forEach((request) =>
        request.flush({ sessions: [{ sessionId: 's1', subagents: [], children: [] }] }),
      );
    await settle();
    TestBed.tick();
    await settle();
    expect(service.branch()).toEqual({ kind: 'attached', commandId: 'c2' });
  });

  it('says nobody is signed in and opens no terminal until somebody presses', async () => {
    const service = await open(
      [command({ id: 'c1', status: 'EXITED', agentSessions: [session('s1')] })],
      [{ sessionId: 's1', subagents: [], children: [] }],
    );
    const signIn = TestBed.inject(AgentSignIn);

    void service.startFresh('CLAUDE');
    await settle();
    // The refusal the harness library throws, as the daemon reports it. Nothing was launched.
    http.expectOne('/workspaces/container/7/agents').flush(
      {
        message:
          'Nobody has signed Claude Code in on this platform’s shared credential volume, so this' +
          ' session cannot start. Open the Claude Code sign-in terminal to complete it once for' +
          ' every container on the volume.',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    TestBed.tick();
    await settle();

    expect(signIn.refusal()?.harness).toBe('CLAUDE');
    expect(signIn.refusal()?.message).toContain('sign-in terminal');
    // Not an error line — the refusal has a next step, so it does not land on the problem surface.
    expect(service.problem()).toBeNull();
    // **The whole point.** Nothing is attached and nothing is on screen but the offer.
    expect(service.branch()).toEqual({ kind: 'idle' });
    expect(sockets).toHaveLength(0);

    // The press. An ordinary launch, and only now is there a terminal.
    void signIn.open(7);
    await settle();
    const door = http.expectOne('/workspaces/container/7/agents/sign-in');
    expect(door.request.body).toEqual({ agentType: 'CLAUDE' });
    door.flush({ command: command({ id: 'login1', actionName: 'Claude sign-in' }) });
    await settle();
    TestBed.tick();
    await settle();

    expect(service.branch()).toEqual({ kind: 'signin', commandId: 'login1' });
    expect(sockets[sockets.length - 1].url).toContain('/terminal/commands/login1');

    // The operator completes the sign-in and the terminal exits. Nothing is replayed: the session
    // starts where every other one does, at a press.
    await refresh([command({ id: 'login1', actionName: 'Claude sign-in', status: 'EXITED' })]);

    expect(signIn.refusal()).toBeNull();
    expect(service.branch()).toEqual({ kind: 'idle' });
    http.expectNone('/workspaces/container/7/agents');
  });

  it('is not dropped into a login terminal by a daemon that still swaps one in', async () => {
    // Until the daemon runs the library that refuses, a signed-out launch answers a login terminal
    // instead of a session. It is recognised, and it is not attached to.
    const service = await open(
      [command({ id: 'c1', status: 'EXITED', agentSessions: [session('s1')] })],
      [{ sessionId: 's1', subagents: [], children: [] }],
    );
    const signIn = TestBed.inject(AgentSignIn);

    void service.startFresh('CLAUDE');
    await settle();
    http
      .expectOne('/workspaces/container/7/agents')
      .flush({ command: command({ id: 'login1', actionName: 'Claude sign-in' }) });
    await settle();
    await answer([
      command({ id: 'c1', status: 'EXITED', agentSessions: [session('s1')] }),
      command({ id: 'login1', actionName: 'Claude sign-in' }),
    ]);

    expect(signIn.refusal()).not.toBeNull();
    expect(service.branch()).toEqual({ kind: 'idle' });
    expect(sockets).toHaveLength(0);

    // The terminal is already spawned, so the press reveals it rather than starting a second REPL
    // to race the first for the same credential file.
    void signIn.open(7);
    await settle();
    TestBed.tick();
    await settle();
    http.expectNone('/workspaces/container/7/agents/sign-in');
    expect(service.branch()).toEqual({ kind: 'signin', commandId: 'login1' });
  });

  it('says the container is gone rather than showing an empty session', async () => {
    const service = TestBed.inject(AgentSession);
    service.use(7);
    TestBed.tick();
    http
      .expectOne('/workspaces/container/7/agent-sessions')
      .flush({ message: 'no daemon' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/agents/available')
      .flush({}, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ message: 'no daemon' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();
    TestBed.tick();
    await settle();
    const branch = service.branch();
    expect(branch.kind).toBe('unavailable');
    expect(branch.kind === 'unavailable' && branch.message).toContain('container');
  });
});
