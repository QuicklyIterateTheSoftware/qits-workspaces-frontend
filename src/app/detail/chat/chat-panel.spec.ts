import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { WorkspaceEvents } from '../../api/workspace-events';
import { WEB_SOCKET_FACTORY, WEB_SOCKET_OPEN, type WebSocketLike } from '../../api/web-socket';
import type { CommandDto } from '../../api/commands-api';
import { ChatPanel } from './chat-panel';
import { SPEECH_RUNTIME, type SpeechRuntime } from './speech-runtime';

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
  readyState = 0;
  closedByClient = false;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }

  connect(): void {
    this.readyState = WEB_SOCKET_OPEN;
    this.onopen?.(new Event('open'));
  }

  deliver(text: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data: text }));
  }
}

const NO_MICROPHONE: SpeechRuntime = {
  supported: () => false,
  capture: () => Promise.reject(new Error('no microphone in jsdom')),
};

const chat = (id: string, status: CommandDto['status']): CommandDto => ({
  id,
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: 'claude chat',
  status,
  interactive: false,
  kind: 'CHAT',
  launchedAt: '2026-08-01T10:00:00Z',
  agentSessions: [],
});

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatPanel],
  template: `<app-chat-panel
    [workspaceRowId]="workspaceRowId()"
    agentId="a1"
    workId="work-1"
    [commandId]="commandId()"
    [preamble]="null"
  />`,
})
class PanelHost {
  readonly workspaceRowId = signal(7);
  readonly commandId = signal<string | null>('cmd-1');
}

const DRAFT_URL = '/workspaces/api/agents/a1/prompt-draft';

/**
 * The Chat tab of one agent: its live chat when it runs one, else the prompt panel, which sends
 * through the delivery door.
 *
 * **On first open this panel reads 1** — the container's command list, a *shared* entry the
 * Terminal tab reads too. The prompt panel's draft read is its own budget, not this one's.
 */
describe('ChatPanel', () => {
  let fixture: ComponentFixture<PanelHost>;
  let http: HttpTestingController;
  let sockets: FakeSocket[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
        { provide: SPEECH_RUNTIME, useValue: NO_MICROPHONE },
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
    fixture = TestBed.createComponent(PanelHost);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Let the request chain land, then render.
   *
   * Several awaits deep: a client call goes through the daemon transport's reachability wrapper and
   * then the panel's own handler, so one microtask turn regularly returns mid-chain.
   */
  const settle = async () => {
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  const commands = () => http.expectOne('/workspaces/container/7/commands');

  const listing = async (entries: CommandDto[]) => {
    fixture.detectChanges();
    commands().flush({ entries: entries.map((command) => ({ command })) });
    await settle();
  };

  const latest = () => sockets[sockets.length - 1];

  const text = (): string => fixture.nativeElement.textContent ?? '';

  it('reads the command list and nothing else of its own', async () => {
    await listing([]);
    // The prompt panel's draft read is the only other request, and it is that panel's budget.
    const draft = http.expectOne(DRAFT_URL);
    draft.flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();
    http.verify();
  });

  it('shows the prompt panel when nothing is running', async () => {
    await listing([chat('old', 'EXITED')]);
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(fixture.nativeElement.querySelector('app-prompt-panel')).not.toBeNull();
    expect(sockets).toHaveLength(0);
  });

  it('says a live chat survives a tab switch', async () => {
    await listing([chat('cmd-1', 'RUNNING')]);
    latest().connect();
    fixture.detectChanges();

    expect(text()).toContain('Switching tabs keeps the agent running');
  });

  it('points a terminal agent at the Terminal tab', async () => {
    await listing([{ ...chat('cmd-1', 'RUNNING'), kind: 'TERMINAL' }]);
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(sockets).toHaveLength(0);
    expect(text()).toContain('its screen is on the Terminal tab');
  });

  it('leaves another agent’s chat alone, even when it runs', async () => {
    await listing([chat('cmd-other', 'RUNNING'), chat('cmd-1', 'EXITED')]);
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(sockets).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('app-prompt-panel')).not.toBeNull();
    expect(text()).toContain('resumes it to hear it');
  });

  it('attaches to the agent’s own running chat, and renders its replay', async () => {
    await listing([chat('cmd-1', 'RUNNING')]);

    expect(sockets).toHaveLength(1);
    expect(latest().url).toContain('/workspaces/container/7/chat/commands/cmd-1');
    expect(fixture.nativeElement.querySelector('app-prompt-panel')).toBeNull();

    latest().connect();
    latest().deliver(
      `${JSON.stringify({ type: 'user', text: 'add a health check' })}\n` +
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } })}\n`,
    );
    fixture.detectChanges();

    expect(text()).toContain('add a health check');
    expect(text()).toContain('On it.');
  });

  it('says that side-chains join at the end, rather than looking broken', async () => {
    // The live tail covers the main session only; the exit sweep imports the side-chains. Unsaid,
    // that reads as an agent spawning sub-agents whose work never appears.
    await listing([chat('cmd-1', 'RUNNING')]);
    latest().connect();
    fixture.detectChanges();

    expect(text()).toContain('Sub-agent side-chains join when the run ends');
  });

  it('sends over the socket and never draws the turn optimistically', async () => {
    await listing([chat('cmd-1', 'RUNNING')]);
    latest().connect();
    fixture.detectChanges();

    const box = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    box.value = 'and a test';
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    press('Send');

    expect(latest().sent).toEqual(['{"type":"user","text":"and a test"}']);
    // Nothing on screen until the server echoes it back.
    expect(text()).not.toContain('and a test');
  });

  it('sends through the delivery door when there is no live chat, and says what became of it', async () => {
    await listing([]);
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    const box = fixture.nativeElement.querySelector('textarea.prompt') as HTMLTextAreaElement;
    box.value = 'build it';
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    press('Send to the agent');
    await settle();

    const save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();

    const delivery = http.expectOne('/workspaces/api/agent-dispatches/delivery');
    expect(delivery.request.body).toMatchObject({ workId: 'work-1', text: 'build it' });
    delivery.flush({ agentId: 'a1', delivered: false, launched: false, resumed: true });
    await settle();

    http.expectOne(DRAFT_URL).flush(null, { status: 204, statusText: 'No Content' });
    commands().flush({ entries: [] });
    await settle();

    expect(text()).toContain('The agent resumes to hear it');
  });

  it('draws the prompt panel for a queued agent without asking a container', async () => {
    fixture.componentInstance.workspaceRowId.set(0);
    fixture.componentInstance.commandId.set(null);
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    http.expectNone('/workspaces/container/0/commands');
    expect(fixture.nativeElement.querySelector('app-prompt-panel')).not.toBeNull();
    // The rewrite runs in the agent's container, which a queued agent does not have.
    expect(text()).not.toContain('Refine into prompt');
  });

  it('terminates, then refetches whether or not it worked', async () => {
    // Mutations invalidate on settled, not on success: a failed terminate still refreshes the truth.
    await listing([chat('cmd-1', 'RUNNING')]);
    latest().connect();
    fixture.detectChanges();

    press('Terminate');
    await settle();

    http
      .expectOne('/workspaces/container/7/commands/cmd-1/terminate')
      .flush({ message: 'gone' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(text()).toContain('The session did not stop');
    commands().flush({ entries: [] });
    await settle();
  });

  it('re-keys the socket on a relaunch rather than reusing one bound to a dead process', async () => {
    await listing([chat('cmd-1', 'RUNNING')]);
    const first = latest();
    first.connect();

    // A `commands` hint is what tells the store to look again; the worktree read names the new id.
    TestBed.inject(WorkspaceEvents).invalidateAll();
    fixture.componentInstance.commandId.set('cmd-2');
    fixture.detectChanges();
    commands().flush({ entries: [{ command: chat('cmd-2', 'RUNNING') }] });
    await settle();

    expect(first.closedByClient).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(latest().url).toContain('cmd-2');
  });

  it('reports the closed envelope as an ending rather than a failure', async () => {
    await listing([chat('cmd-1', 'RUNNING')]);
    latest().connect();
    latest().deliver(`${JSON.stringify({ type: 'session_closed' })}\n`);
    fixture.detectChanges();

    expect(text()).toContain('This conversation has ended');
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
  });

  function press(label: string): void {
    const button = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((candidate) => candidate.textContent?.trim().startsWith(label));
    if (!button) {
      throw new Error(`No button reading "${label}"`);
    }
    button.click();
    fixture.detectChanges();
  }
});
