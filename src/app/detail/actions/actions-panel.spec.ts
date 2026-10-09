import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ActionDto, CommandDto } from '../../api/commands-api';
import type { WorkspaceRuntimeStatus } from '../../api/dto';
import { ActionsPanel } from './actions-panel';

const command = (over: Partial<CommandDto> = {}): CommandDto => ({
  id: 'c1',
  repoId: 'repo',
  workspaceId: 'task-login',
  branch: 'task/login',
  actionName: 'build',
  status: 'EXITED',
  interactive: false,
  kind: 'TERMINAL',
  launchedAt: '2026-08-01T10:00:00Z',
  exitCode: 0,
  agentSessions: [],
  ...over,
});

const ACTIONS: readonly ActionDto[] = [
  { id: 'build', name: 'Build', interactive: false },
  { id: 'shell', name: 'Shell', interactive: true },
];

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActionsPanel],
  template: `<app-actions-panel
    [workspaceRowId]="id()"
    [runtimeStatus]="runtime()"
    [daemonConnected]="daemonConnected()"
    [visible]="visible()"
  />`,
})
class PanelHost {
  readonly id = signal(7);
  readonly visible = signal(true);
  readonly runtime = signal<WorkspaceRuntimeStatus | null>('RUNNING');
  readonly daemonConnected = signal(false);
}

/**
 * The Actions tab: the declared actions, the run history, and the bootstrap section under them.
 *
 * **The load budget is asserted, not just written down**: four reads on first open — the actions,
 * the bootstrap chain, its host-side run rows, and the shared command list. The fourth is free
 * whenever anything else has already read it, which on a real page open means Chat has; here nothing
 * has, so it is paid for and counted.
 *
 * **The container-stopped state is the assertion that matters most.** The run history is the
 * daemon's in-memory store and there is no host-side fallback — `WorkspaceCommandHistory` is an
 * unbound port and answers `[]` for every workspace — so a stopped container has an *unreadable*
 * history, not an empty one. Rendering it as an empty list would state the opposite of what is true,
 * and it is the kind of thing a test that only checked the happy path would never catch.
 */
describe('ActionsPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return element().textContent ?? '';
  }

  function actionNames(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.actions .row .name')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  function historyNames(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.history .run .name')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  async function open(
    actions: readonly ActionDto[] = ACTIONS,
    commands: readonly CommandDto[] = [command()],
  ): Promise<void> {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();
    answer(actions, commands);
    await settle();
  }

  function answer(actions: readonly ActionDto[], commands: readonly CommandDto[]): void {
    http.expectOne('/workspaces/container/7/commands/actions').flush({ actions });
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ entries: commands.map((entry) => ({ command: entry })) });
    http.expectOne('/workspaces/container/7/bootstrap-commands').flush({ steps: [] });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
  }

  it('reads four surfaces on first open, three of its own and the shared command list', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();

    const requests = http.match(() => true);
    expect(requests.length).toBe(4);
    expect(requests.map((request) => request.request.url).sort()).toEqual([
      '/workspaces/api/workspaces/7/bootstrap-runs',
      '/workspaces/container/7/bootstrap-commands',
      '/workspaces/container/7/commands',
      '/workspaces/container/7/commands/actions',
    ]);

    // Answered by url rather than by position: the panel is free to issue them in any order, and a
    // test that pinned the order would fail on a change that is not a defect.
    for (const request of requests) {
      const url = request.request.url;
      if (url.endsWith('/commands/actions')) {
        request.flush({ actions: [] });
      } else if (url.endsWith('/bootstrap-commands')) {
        request.flush({ steps: [] });
      } else if (url.endsWith('/bootstrap-runs')) {
        request.flush({ runs: [] });
      } else {
        request.flush({ entries: [] });
      }
    }
    await settle();
  });

  it('lists the declared actions and badges the interactive one', async () => {
    await open();
    expect(actionNames()).toEqual(['Build', 'Shell']);
    const badges = Array.from(element().querySelectorAll<HTMLElement>('.actions .badge'));
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toContain('interactive');
  });

  it('says an action reports through the history, because no inline result is possible', async () => {
    await open();
    expect(text()).toContain('there is no inline result');
    expect(text()).toContain('control socket');
  });

  it('runs an action and re-reads the history when the launch settles', async () => {
    await open();

    element().querySelector<HTMLElement>('.actions .row qits-button button')!.click();
    await settle();

    const launch = http.expectOne('/workspaces/container/7/commands');
    expect(launch.request.body).toEqual({ actionId: 'build' });
    launch.flush({ command: command({ id: 'c2', status: 'RUNNING', exitCode: undefined }) });
    await settle();

    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ entries: [{ command: command({ id: 'c2', actionName: 'build' }) }] });
    await settle();
    expect(historyNames()).toEqual(['build']);
  });

  it('re-reads the history even when the launch is refused', async () => {
    await open();

    element().querySelector<HTMLElement>('.actions .row qits-button button')!.click();
    await settle();
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ message: 'no such action' }, { status: 400, statusText: 'Bad Request' });
    await settle();

    http.expectOne('/workspaces/container/7/commands').flush({ entries: [] });
    await settle();
    expect(text()).toContain('Nothing has run in this container yet.');
  });

  it('says the history is unreadable, not empty, when the container is stopped', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    host.runtime.set('STOPPED');
    await settle();

    http
      .expectOne('/workspaces/container/7/commands/actions')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/bootstrap-commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();

    expect(text()).toContain('run history lives in the container');
    expect(text()).toContain('This is not an empty history: it is an unreadable one.');
    expect(text()).not.toContain('Nothing has run in this container yet.');
    // And the 502 is not reported twice, as a bare status beside the sentence that explains it.
    expect(element().querySelector('.async-error')).toBeNull();
  });

  it('offers Terminate on a running row and a log on a finished one', async () => {
    await open(ACTIONS, [
      command({ id: 'c1', actionName: 'build', status: 'EXITED', exitCode: 2 }),
      command({ id: 'c2', actionName: 'serve', status: 'RUNNING', exitCode: undefined }),
    ]);

    const rows = Array.from(element().querySelectorAll<HTMLElement>('.history .run'));
    expect(rows[0].querySelector('.link')?.textContent).toContain('Log');
    expect(rows[1].querySelector('qits-button')?.textContent).toContain('Terminate');
  });

  it('reads a command’s log only when its row is expanded', async () => {
    await open(ACTIONS, [command({ id: 'c1', actionName: 'build' })]);

    element().querySelector<HTMLElement>('.history .link')!.click();
    await settle();

    http.expectOne('/workspaces/container/7/commands/c1/log').flush({
      lines: [{ sequence: 1, channel: 'OUTPUT', content: 'compiling', timestamp: 'now' }],
    });
    await settle();
    expect(element().querySelector('.log')?.textContent).toContain('compiling');
  });

  it('badges a run that is not a plain terminal run, and shows every kind in the list', async () => {
    await open(ACTIONS, [
      command({ id: 'c1', actionName: 'claude', kind: 'CHAT' }),
      command({ id: 'c2', actionName: 'build', kind: 'TERMINAL' }),
    ]);

    const badges = Array.from(element().querySelectorAll<HTMLElement>('.history .badge')).map(
      (node) => node.textContent?.trim(),
    );
    expect(badges).toEqual(['chat']);
    expect(historyNames()).toEqual(['claude', 'build']);
  });

  /**
   * A runner-placed row can report `UNAVAILABLE` while its daemon is still reachable through the
   * edge — the runner being offline says nothing about the control socket, which does not route
   * through it. `containerGone` must not treat that row as gone, or the whole tab would refuse to
   * load a session that is, in fact, live.
   */
  it('treats UNAVAILABLE with a connected daemon as live, not gone', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    host.runtime.set('UNAVAILABLE');
    host.daemonConnected.set(true);
    await settle();
    answer(ACTIONS, [command()]);
    await settle();

    expect(text()).not.toContain('The container is stopped');
    expect(actionNames()).toEqual(['Build', 'Shell']);
  });

  it('keeps UNAVAILABLE without a connected daemon reading as gone, unchanged', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    host.runtime.set('UNAVAILABLE');
    await settle();

    http
      .expectOne('/workspaces/container/7/commands/actions')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne('/workspaces/container/7/bootstrap-commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();

    expect(text()).toContain('The container is stopped');
  });

  it('does not read while hidden, and catches up on becoming visible', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    host.visible.set(false);
    await settle();

    // Only the shared command list is read, because it is owned elsewhere and keeps itself fresh;
    // this panel's own three reads wait for the tab.
    http.expectOne('/workspaces/container/7/commands').flush({ entries: [] });
    http.expectNone('/workspaces/container/7/commands/actions');

    host.visible.set(true);
    await settle();
    http.expectOne('/workspaces/container/7/commands/actions').flush({ actions: [] });
    http.expectOne('/workspaces/container/7/bootstrap-commands').flush({ steps: [] });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();
  });
});
