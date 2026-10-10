import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './event-source';
import { WorkspaceCommands } from './workspace-commands';
import { WorkspaceEvents } from './workspace-events';
import type { CommandDto } from './commands-api';

/** Several turns, because a client call is several awaits deep. */
const settle = async () => {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
  }
};

const command = (
  id: string,
  kind: CommandDto['kind'],
  status: CommandDto['status'],
): CommandDto => ({
  id,
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: id,
  status,
  interactive: false,
  kind,
  launchedAt: '2026-08-01T10:00:00Z',
  agentSessions: [],
});

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  close(): void {
    this.readyState = 2;
  }
}

/**
 * The one command-list entry, and why it is one.
 *
 * Four surfaces read it — Chat's "is a conversation live", the Actions run history, the session tree
 * and the embedded session — and four readers are affordable only if there is one fetch behind them.
 * That is also why the refetch lives here and not in the readers: one `commands` hint would
 * otherwise become four identical requests.
 */
describe('WorkspaceCommands', () => {
  let store: WorkspaceCommands;
  let events: WorkspaceEvents;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
      ],
    });
    store = TestBed.inject(WorkspaceCommands);
    events = TestBed.inject(WorkspaceEvents);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('does not ask before it is pointed at a workspace', () => {
    TestBed.tick();
    expect(store.commands().kind).toBe('idle');
    http.expectNone(() => true);
  });

  it('reads once per workspace, however many readers call use()', async () => {
    store.use(7);
    store.use(7);
    store.use(7);
    TestBed.tick();

    http.expectOne('/workspaces/container/7/commands').flush({ entries: [] });
    await settle();
  });

  it('re-reads on a commands hint, and on nothing else', async () => {
    store.use(7);
    TestBed.tick();
    http.expectOne('/workspaces/container/7/commands').flush({ entries: [] });
    await settle();

    events.invalidations('files');
    TestBed.tick();
    http.expectNone('/workspaces/container/7/commands');

    // The channel's own connect bumps every counter, which includes this one.
    events.invalidateAll();
    TestBed.tick();
    http.expectOne('/workspaces/container/7/commands').flush({ entries: [] });
    await settle();
  });

  it('blanks the entry when the workspace under it changes', async () => {
    store.use(7);
    TestBed.tick();
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ entries: [{ command: command('a', 'CHAT', 'RUNNING') }] });
    await settle();
    TestBed.tick();
    const first = store.commands();
    expect(first.kind === 'ready' && first.value[0].id).toBe('a');

    // One workspace's runs are not a stale view of another's.
    store.use(8);
    expect(store.commands().kind).toBe('loading');
    TestBed.tick();
    http.expectOne('/workspaces/container/8/commands').flush({ entries: [] });
    await settle();
  });

  it('keeps a container failure as an error state rather than an empty list', async () => {
    // A stopped container has no run history at all — there is no host-side fallback — so an empty
    // list would be a lie about a real failure.
    store.use(7);
    TestBed.tick();
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    await settle();

    expect(store.commands().kind).toBe('error');
  });
});
