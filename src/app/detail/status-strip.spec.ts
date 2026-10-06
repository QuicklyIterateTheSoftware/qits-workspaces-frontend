import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { WorkspaceDto } from '../api/dto';
import type { DaemonReachability } from '../api/workspace-daemon-api';
import { StatusStrip } from './status-strip';

const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 7,
  workspaceId: 'task-widgets',
  parent: 'epic/widgets',
  branch: 'task/widgets',
  ahead: 2,
  behind: 1,
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
 * The state the detail view never showed, and the guard that has to explain itself.
 *
 * **Recreate is refused with a 400 unless the working tree is provably clean**, and `clean: null` —
 * what a workspace with no live daemon reports — counts as not clean. That is the sharp edge and the
 * reason it gets three tests: recreate is the *remedy* for an outdated daemon, an outdated daemon is
 * quite often a disconnected one, and a disconnected daemon reports null. So the button people reach
 * for in exactly that situation is the one that must say why it cannot be pressed, rather than
 * turning a server-side guard into an error message after the click.
 *
 * **The daemon's absence is a sentence, not seven 502s.** The reverse tunnel made the daemon's
 * control socket load-bearing for the container proxy, so a blip takes the file browser, every
 * terminal and the whole agent surface down at once. Two things can tell us: the workspace row
 * reporting no connection, and the proxy having just failed to reach anything. Either is enough.
 */
describe('StatusStrip', () => {
  const render = async (
    over: Partial<WorkspaceDto> = {},
    options: { mainBranch?: string; reachability?: DaemonReachability } = {},
  ) => {
    const fixture = TestBed.createComponent(StatusStrip);
    fixture.componentRef.setInput('workspace', workspace(over));
    fixture.componentRef.setInput('mainBranch', options.mainBranch ?? 'main');
    fixture.componentRef.setInput('reachability', options.reachability ?? 'unknown');
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };

  const text = (fixture: { nativeElement: HTMLElement }): string =>
    fixture.nativeElement.textContent ?? '';

  const recreate = (fixture: { nativeElement: HTMLElement }): HTMLButtonElement =>
    Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.trim() === 'Recreate',
    ) as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('offers recreate when the tree is provably clean', async () => {
    const fixture = await render({ clean: true });

    expect(recreate(fixture).disabled).toBe(false);
    expect(text(fixture)).not.toContain('Recreate needs');
  });

  it('refuses recreate on a dirty tree, and says what it would throw away', async () => {
    const fixture = await render({ clean: false });

    expect(recreate(fixture).disabled).toBe(true);
    expect(text(fixture)).toContain('uncommitted changes, and recreating would throw them away');
  });

  it('refuses recreate when cleanliness is unknown, because unknown is not clean', async () => {
    const fixture = await render({ clean: null });

    expect(recreate(fixture).disabled).toBe(true);
    expect(text(fixture)).toContain('Nothing is reporting one here');
  });

  it('draws unknown cleanliness as unknown rather than as clean', async () => {
    const fixture = await render({ clean: null });

    expect(text(fixture)).toContain('working tree unknown');
  });

  it('says the daemon is gone when a running container reports no connection', async () => {
    const fixture = await render({ runtimeStatus: 'RUNNING', daemonConnectedAt: null });

    expect(text(fixture)).toContain('Files, terminals and the agent surface cannot work right now');
  });

  it('says the daemon is gone when the proxy has just failed to reach it', async () => {
    const fixture = await render({}, { reachability: 'unreachable' });

    expect(text(fixture)).toContain('Files, terminals and the agent surface cannot work right now');
  });

  it('does not claim a missing daemon when there is no container to hold one', async () => {
    const fixture = await render({ runtimeStatus: 'STOPPED', daemonConnectedAt: null });

    expect(text(fixture)).toContain('No container running');
    expect(text(fixture)).not.toContain('cannot work right now');
  });

  it('points an outdated daemon at the recreate that replaces it', async () => {
    const fixture = await render({ daemonOutdated: true, clean: true });

    expect(text(fixture)).toContain('outdated');
    expect(text(fixture)).toContain('Recreating the container is the way to replace it');
  });

  it('offers integrate for work parented anywhere but the default branch', async () => {
    const fixture = await render({ parent: 'epic/widgets' }, { mainBranch: 'main' });

    expect(text(fixture)).toContain('Integrate');
  });

  /** The default branch is written by a release request in qits-projects, and by nothing here. */
  it('offers no door at all for work parented on the default branch', async () => {
    const fixture = await render({ parent: 'main' }, { mainBranch: 'main' });

    expect(text(fixture)).not.toContain('Integrate');
    expect(text(fixture)).toContain('release request');
  });

  it('shows the runtime error the list used to keep to itself', async () => {
    const fixture = await render({ runtimeStatus: 'FAILED', runtimeError: 'image pull refused' });

    expect(text(fixture)).toContain('image pull refused');
  });

  it('draws the quiet marker when the hint channel is down, and nothing when it is up', async () => {
    const fixture = await render();
    expect(text(fixture)).not.toContain('Live updates are reconnecting');

    fixture.componentRef.setInput('live', false);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text(fixture)).toContain('Live updates are reconnecting');
  });

  it('refreshes after a failed verb, because settled is what invalidates and not success', async () => {
    const fixture = await render({ runtimeStatus: 'STOPPED' });
    const changes: number[] = [];
    fixture.componentInstance.changed.subscribe(() => changes.push(1));

    const start = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button: unknown) => (button as HTMLButtonElement).textContent?.trim() === 'Start',
    ) as HTMLButtonElement;
    start.click();
    await fixture.whenStable();

    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/ensure-container')
      .flush({ message: 'no' }, { status: 500, statusText: 'Server Error' });
    // The rejection settles through a promise chain the fixture does not own, so let the queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(changes).toEqual([1]);
    expect(text(fixture)).toContain('That did not work');
  });

  const press = async (fixture: Awaited<ReturnType<typeof render>>, label: string) => {
    const button = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (candidate: unknown) => (candidate as HTMLButtonElement).textContent?.trim() === label,
    ) as HTMLButtonElement;
    expect(button, `a button labelled "${label}"`).toBeTruthy();
    button.click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  it('escalates to the ignore-changes confirmation only after the guard refuses', async () => {
    const fixture = await render({ clean: false });
    await press(fixture, 'Discard…');
    await press(fixture, 'Discard this workspace');

    // The first request must be incapable of losing work: no override parameter, ever.
    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/discard')
      .flush(
        { message: "Cannot abandon workspace 'task-widgets': it has uncommitted changes." },
        { status: 400, statusText: 'Bad Request' },
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    // The refusal becomes the second confirmation, not an error message.
    expect(text(fixture)).toContain('no way back');
    expect(text(fixture)).not.toContain('That did not work');

    await press(fixture, 'Discard anyway — lose the changes');
    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/discard?ignore-changes=true')
      .flush({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(text(fixture)).not.toContain('no way back');
  });

  it('keeps every other discard failure an ordinary failure', async () => {
    const fixture = await render();
    await press(fixture, 'Discard…');
    await press(fixture, 'Discard this workspace');

    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/discard')
      .flush({ message: 'the git host is unreachable' }, { status: 500, statusText: 'Server Error' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(text(fixture)).toContain('That did not work');
    expect(text(fixture)).not.toContain('Discard anyway');
  });

  it('leaves the escalation behind when the confirmation is declined', async () => {
    const fixture = await render({ clean: false });
    await press(fixture, 'Discard…');
    await press(fixture, 'Discard this workspace');
    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/discard')
      .flush(
        { message: 'it has uncommitted changes' },
        { status: 400, statusText: 'Bad Request' },
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    await press(fixture, 'Keep the workspace');

    expect(text(fixture)).not.toContain('no way back');
    // Declining drops back to the plain form (the note survives), and the next attempt is plain
    // again: declining must not leave the override armed.
    await press(fixture, 'Discard this workspace');
    TestBed.inject(HttpTestingController)
      .expectOne('/workspaces/api/workspaces/7/discard')
      .flush({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  describe('a runner-placed workspace', () => {
    const verb = (fixture: { nativeElement: HTMLElement }, label: string): HTMLButtonElement =>
      Array.from(fixture.nativeElement.querySelectorAll('button')).find(
        (button) => (button as HTMLButtonElement).textContent?.trim() === label,
      ) as HTMLButtonElement;

    const containerBadge = (fixture: { nativeElement: HTMLElement }): HTMLElement =>
      fixture.nativeElement.querySelector(
        'section[aria-label="Container"] qits-badge span',
      ) as HTMLElement;

    it('reads QUEUED as info and names the runner it waits on', async () => {
      const fixture = await render({
        placement: 'RUNNER',
        runtimeStatus: 'QUEUED',
        runner: { id: 'r-1', name: 'node-a' },
        queuedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        daemonConnectedAt: null,
      });

      expect(containerBadge(fixture).className).toContain('qits-badge-info');
      expect(containerBadge(fixture).textContent).toContain('queued');
      expect(text(fixture)).toContain('waiting for a slot on node-a since 5m ago');
    });

    it('says it waits for any runner when none has taken it yet', async () => {
      const fixture = await render({
        placement: 'RUNNER',
        runtimeStatus: 'QUEUED',
        runner: null,
        queuedAt: null,
        daemonConnectedAt: null,
      });

      expect(text(fixture)).toContain('waiting for a runner');
      expect(text(fixture)).not.toContain('waiting for a slot on');
    });

    it('reads UNAVAILABLE as a warning, says the runner is offline, and disables the verbs', async () => {
      const fixture = await render({
        placement: 'RUNNER',
        runtimeStatus: 'UNAVAILABLE',
        runner: { id: 'r-1', name: 'node-a' },
        clean: true,
        daemonConnectedAt: null,
      });

      expect(containerBadge(fixture).className).toContain('qits-badge-warning');
      expect(containerBadge(fixture).textContent).toContain('unavailable');
      expect(text(fixture)).toContain('runner node-a is offline');
      // Start (the row is not RUNNING) and Recreate, even with a provably clean tree.
      for (const label of ['Start', 'Recreate']) {
        expect(verb(fixture, label).disabled).toBe(true);
        expect(verb(fixture, label).closest('qits-button')?.getAttribute('title')).toBe(
          'runner node-a is offline',
        );
      }
    });

    it('names the runner a running workspace is on', async () => {
      const fixture = await render({ placement: 'RUNNER', runner: { id: 'r-1', name: 'node-a' } });

      expect(text(fixture)).toContain('on runner node-a');
      expect(verb(fixture, 'Stop').disabled).toBe(false);
    });

    it('leaves a DIRECT row exactly as it was', async () => {
      const before = await render({});
      const direct = await render({ placement: 'DIRECT', runner: null, queuedAt: null });

      expect(direct.nativeElement.innerHTML).toBe(before.nativeElement.innerHTML);
      expect(direct.nativeElement.querySelector('.placement')).toBeNull();
      expect(verb(direct, 'Stop').disabled).toBe(false);
      expect(verb(direct, 'Recreate').disabled).toBe(false);
    });
  });
});
