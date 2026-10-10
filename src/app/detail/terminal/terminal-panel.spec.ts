import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { CommandDto } from '../../api/commands-api';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { WEB_SOCKET_FACTORY, type WebSocketLike } from '../../api/web-socket';
import { TerminalPanel } from './terminal-panel';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  close(): void {
    this.readyState = 3;
  }
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closedByClient = false;
  constructor(readonly url: string) {}
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
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
  launchedAt: 'T',
  agentSessions: [],
  ...over,
});

@Component({
  selector: 'app-terminal-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TerminalPanel],
  template: `<app-terminal-panel
    [workspaceRowId]="rowId()"
    agentId="a1"
    [commandId]="commandId()"
    harness="CLAUDE"
  />`,
})
class TerminalHost {
  readonly rowId = signal(7);
  readonly commandId = signal<string | null>('cmd-1');
}

/** The Terminal tab: the agent's interactive harness, the sign-in door, and nothing launched. */
describe('TerminalPanel', () => {
  let fixture: ComponentFixture<TerminalHost>;
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

  const settle = async () => {
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  /** Mount and answer the three reads: commands, the harness report and the plugin store. */
  async function open(
    commands: readonly CommandDto[],
    capabilities: readonly unknown[] = [{ harness: 'CLAUDE', authenticated: true }],
  ): Promise<void> {
    fixture = TestBed.createComponent(TerminalHost);
    fixture.detectChanges();
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ entries: commands.map((entry) => ({ command: entry })) });
    http
      .expectOne('/workspaces/container/7/agents/available')
      .flush({ agents: ['CLAUDE'], defaultAgent: 'CLAUDE', capabilities });
    await settle();
    for (const request of http.match((candidate) => candidate.url.endsWith('/agent-plugins'))) {
      request.flush({ installed: [] });
    }
    for (const request of http.match((candidate) => candidate.url.endsWith('/detection'))) {
      request.flush({ projects: [], frameworks: [], links: [], generation: 'g' });
    }
    await settle();
  }

  it('attaches to the agent’s interactive harness', async () => {
    await open([command({ id: 'cmd-1' })]);
    expect(sockets.map((socket) => socket.url)).toEqual([
      expect.stringContaining('/workspaces/container/7/terminal/commands/cmd-1'),
    ]);
    http.verify();
  });

  it('draws no terminal for a chat agent, and says where its conversation is', async () => {
    await open([command({ id: 'cmd-1', kind: 'CHAT', interactive: false })]);
    expect(sockets).toHaveLength(0);
    expect(text()).toContain('This agent runs as a chat');
  });

  it('never attaches to another agent’s terminal', async () => {
    await open([command({ id: 'cmd-other' }), command({ id: 'cmd-1', status: 'EXITED' })]);
    expect(sockets).toHaveLength(0);
    expect(text()).toContain('harness is not running');
  });

  it('says nobody is signed in, and opens the sign-in terminal on a press', async () => {
    await open([], [{ harness: 'CLAUDE', authenticated: false, authDetail: 'Run claude login.' }]);
    expect(text()).toContain('Nobody has signed Claude Code in');

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((candidate) => candidate.textContent?.includes('Open the sign-in terminal'));
    button!.click();
    await settle();

    const door = http.expectOne('/workspaces/container/7/agents/sign-in');
    expect(door.request.body).toEqual({ agentType: 'CLAUDE' });
    door.flush({ command: command({ id: 'login-1', actionName: 'Claude sign-in' }) });
    await settle();

    expect(sockets.map((socket) => socket.url)).toEqual([
      expect.stringContaining('/terminal/commands/login-1'),
    ]);
    expect(text()).toContain('The sign-in terminal');
  });

  it('says a queued agent has no terminal, and asks no container', async () => {
    fixture = TestBed.createComponent(TerminalHost);
    fixture.componentInstance.rowId.set(0);
    fixture.detectChanges();
    await settle();

    http.expectNone(() => true);
    expect(text()).toContain('queued and has no workspace yet');
  });
});
