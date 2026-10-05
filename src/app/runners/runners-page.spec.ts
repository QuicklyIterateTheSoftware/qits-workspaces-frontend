import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import type { RunnerRegistrationDto, WorkspaceDto, WorkspaceRunnerDto } from '../api/dto';
import { VIEWER_ADMIN } from '../ui/viewer';
import { RunnersPage } from './runners-page';

const RUNNERS_URL = '/workspaces/api/runners';

const runner = (over: Partial<WorkspaceRunnerDto> = {}): WorkspaceRunnerDto => ({
  id: 'r-1',
  name: 'node-a',
  description: null,
  slots: 2,
  version: '2026.1003.1',
  arch: 'amd64',
  dotClaudeVolume: 'qits-workspaces-runner-dot-claude-r1',
  login: { claude: 'PRESENT', kimi: 'ABSENT', checkedAt: '2026-10-05T09:00:00Z' },
  registered: true,
  registeredAt: '2026-10-04T09:00:00Z',
  quarantined: false,
  quarantinedAt: null,
  quarantineReason: null,
  eligible: true,
  lastSeenAt: '2026-10-05T09:00:00Z',
  lastHealthCheckAt: null,
  lastHealthCheckOk: null,
  createdAt: '2026-10-04T08:00:00Z',
  connected: true,
  connectedSince: '2026-10-05T08:00:00Z',
  pinnedVersion: '2026.1003.1',
  running: 1,
  owned: 3,
  queued: 1,
  loginCommand: 'docker run --rm -it -v dot-claude:/root/.claude qits/claude login',
  kimiLoginCommand: 'docker run --rm -it -v dot-claude:/root/.kimi qits/kimi login',
  ...over,
});

const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 12,
  workspaceId: 'task-x',
  parent: 'main',
  branch: 'task/x',
  ahead: 0,
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
  daemonConnectedAt: null,
  daemonVersion: null,
  daemonBuildTime: null,
  daemonOutdated: null,
  ...over,
});

/**
 * The runners page: what it lists, what it shows exactly once, and what it keeps from a viewer who
 * cannot press it.
 *
 * **The install line is the one thing the page must not keep.** Its token is single-use and the
 * service never answers it again, so a create shows it in a panel, closing the panel drops it, and
 * nothing re-reads it — the list after a create carries no trace of it.
 *
 * **A refused delete names workspaces, and a name is not enough.** The 409 carries row ids alone,
 * and the detail route needs the repository too, so the page looks the ids up in each project's
 * wrapper list and links what it finds — listing, by number, what it does not.
 */
describe('RunnersPage', () => {
  let http: HttpTestingController;

  const configure = (admin = true) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsRepositoryList([]),
        provideQitsScope('repository'),
        { provide: VIEWER_ADMIN, useValue: admin },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  };

  afterEach(() => http.verify());

  const settle = async (fixture: ComponentFixture<RunnersPage>): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const open = async (
    runners: readonly WorkspaceRunnerDto[],
  ): Promise<ComponentFixture<RunnersPage>> => {
    const fixture = TestBed.createComponent(RunnersPage);
    await settle(fixture);
    http.expectOne(RUNNERS_URL).flush(runners);
    await settle(fixture);
    return fixture;
  };

  const element = (fixture: ComponentFixture<RunnersPage>): HTMLElement =>
    fixture.nativeElement as HTMLElement;

  const text = (fixture: ComponentFixture<RunnersPage>): string =>
    element(fixture).textContent ?? '';

  const button = (fixture: ComponentFixture<RunnersPage>, label: string): HTMLButtonElement => {
    const found = Array.from(element(fixture).querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) {
      throw new Error(`no button labelled "${label}"`);
    }
    return found;
  };

  const type = (fixture: ComponentFixture<RunnersPage>, name: string, value: string): void => {
    const input = element(fixture).querySelector(`input[name="${name}"]`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  describe('as an admin', () => {
    beforeEach(() => configure(true));

    it('lists what a runner is doing: connection, version, slots, owned and queued', async () => {
      const fixture = await open([runner()]);

      expect(text(fixture)).toContain('node-a');
      expect(text(fixture)).toContain('connected');
      expect(text(fixture)).toContain('v2026.1003.1');
      expect(text(fixture)).toContain('1/2 slots running');
      expect(text(fixture)).toContain('3 owned');
      expect(text(fixture)).toContain('1 queued');
    });

    it('says a connected runner off the pinned version is updating', async () => {
      const fixture = await open([
        runner({ name: 'behind', version: '2026.1001.1' }),
        runner({ id: 'r-2', name: 'current' }),
        runner({ id: 'r-3', name: 'offline', version: '2026.1001.1', connected: false }),
      ]);

      const row = (name: string) => element(fixture).querySelector(`[data-runner="${name}"]`)!;
      expect(row('behind').querySelector('.updating')?.textContent).toContain('updating');
      expect(row('current').querySelector('.updating')).toBeNull();
      // An offline runner is not rolling over to anything; it is offline.
      expect(row('offline').querySelector('.updating')).toBeNull();
      expect(row('offline').textContent).toContain('offline');
    });

    it('draws a quarantined runner with its reason', async () => {
      const fixture = await open([
        runner({
          quarantined: true,
          quarantinedAt: '2026-10-05T09:00:00Z',
          quarantineReason: 'image pull failed',
        }),
      ]);

      expect(text(fixture)).toContain('quarantined');
      expect(text(fixture)).toContain('image pull failed');
    });

    it('shows the install line once after a create, and never again', async () => {
      const fixture = await open([]);

      type(fixture, 'name', 'node-b');
      type(fixture, 'description', 'the CI VM');
      type(fixture, 'slots', '3');
      element(fixture)
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle(fixture);

      const create = http.expectOne(
        (request) => request.method === 'POST' && request.url === RUNNERS_URL,
      );
      expect(create.request.body).toEqual({ name: 'node-b', description: 'the CI VM', slots: 3 });
      const registration: RunnerRegistrationDto = {
        runner: runner({ id: 'r-b', name: 'node-b', registered: false, connected: false }),
        registrationToken: 'tok-123',
        installLine: 'curl -fsSL https://workspaces.example/install.sh | sh -s tok-123',
      };
      create.flush(registration, { status: 201, statusText: 'Created' });
      await settle(fixture);
      http
        .expectOne((request) => request.method === 'GET' && request.url === RUNNERS_URL)
        .flush([registration.runner]);
      await settle(fixture);

      const panel = element(fixture).querySelector('.panel')!;
      expect(panel.querySelector('.install-line')?.textContent).toContain(
        'install.sh | sh -s tok-123',
      );
      expect(panel.querySelector('.token')?.textContent).toContain('tok-123');
      expect(panel.textContent).toContain('reloading this page loses it');

      button(fixture, 'Close').click();
      await settle(fixture);

      expect(element(fixture).querySelector('.panel')).toBeNull();
      // The list the create re-read carries the runner and nothing of its token.
      expect(text(fixture)).toContain('node-b');
      expect(text(fixture)).not.toContain('tok-123');
    });

    it('lists the workspaces a refused delete names, linking the ones it can find', async () => {
      const fixture = await open([runner()]);

      button(fixture, 'Actions').click();
      await settle(fixture);
      button(fixture, 'Delete').click();
      await settle(fixture);
      button(fixture, 'Yes, delete it').click();
      await settle(fixture);

      http.expectOne(`${RUNNERS_URL}/r-1`).flush(
        {
          message: 'RUNNER_OWNS_WORKSPACES: runner node-a owns 2 active workspaces',
          code: 'RUNNER_OWNS_WORKSPACES',
          workspaceIds: [12, 99],
        },
        { status: 409, statusText: 'Conflict' },
      );
      await settle(fixture);
      http.expectOne('/projects/api/projects').flush({
        entries: [
          { project: { id: 'p1', name: 'qits', slug: 'qits', description: null, dns: null } },
        ],
      });
      await settle(fixture);
      http.expectOne('/projects/api/projects/p1/repositories').flush({
        entries: [],
        wrapper: { repositoryId: 'qits-qits', branch: 'main', entries: [] },
      });
      await settle(fixture);
      http
        .expectOne('/workspaces/api/workspaces?repositoryId=qits-qits')
        .flush({ entries: [{ workspace: workspace() }] });
      await settle(fixture);

      const owners = element(fixture).querySelector('.owners')!;
      expect(owners.textContent).toContain('still owns 2 workspaces');
      const link = owners.querySelector('a')!;
      expect(link.textContent).toContain('task/x');
      expect(link.getAttribute('href')).toBe('/repositories/qits-qits/workspaces/12');
      // Not in any wrapper's list: still named, because it still blocks the delete.
      expect(owners.textContent).toContain('workspace #99');
    });

    it.each([
      ['PRESENT', 'logged in'],
      ['ABSENT', 'not logged in'],
      ['UNKNOWN', 'unknown'],
    ] as const)('draws a %s login as "%s", with the command to log in', async (presence, label) => {
      const fixture = await open([
        runner({ login: { claude: presence, kimi: null, checkedAt: '2026-10-05T09:00:00Z' } }),
      ]);

      const login = element(fixture).querySelector('.login')!;
      expect(login.querySelector('.presence-claude')?.textContent?.trim()).toBe(label);
      expect(login.querySelector('.presence-kimi')?.textContent?.trim()).toBe('not reported');
      expect(login.textContent).toContain('checked');
      expect(login.querySelector('.login-command')?.textContent).toContain('qits/claude login');
      expect(login.querySelector('.kimi-login-command')?.textContent).toContain('qits/kimi login');
    });

    it('waits for the node volume before offering a login command', async () => {
      const fixture = await open([
        runner({ login: null, loginCommand: null, kimiLoginCommand: null }),
      ]);

      const login = element(fixture).querySelector('.login')!;
      expect(login.textContent).toContain('not reported yet');
      expect(login.querySelector('.login-command')).toBeNull();
      expect(login.textContent).toContain('appears once the runner has reported its node volume');
    });

    it('says the login command waits for the workspace image when the runner has not got it yet', async () => {
      const fixture = await open([
        runner({
          login: null,
          loginCommand: null,
          kimiLoginCommand: null,
          loginCommandPending: true,
        }),
      ]);

      const login = element(fixture).querySelector('.login')!;
      expect(login.querySelector('.login-command')).toBeNull();
      expect(login.querySelector('.command')).toBeNull();
      expect(login.textContent).toContain('still fetching the workspace image');
      expect(login.textContent).toContain('appears here once it is on the node');
    });

    it('keeps the login command unchanged when loginCommandPending is false', async () => {
      const fixture = await open([runner({ loginCommandPending: false })]);

      const login = element(fixture).querySelector('.login')!;
      expect(login.querySelector('.login-command')?.textContent).toContain('qits/claude login');
      expect(login.textContent).not.toContain('still fetching the workspace image');
    });

    it('asks the runner to re-check its login', async () => {
      const fixture = await open([runner()]);

      button(fixture, 'Re-check').click();
      await settle(fixture);

      const check = http.expectOne(`${RUNNERS_URL}/r-1/login-check`);
      expect(check.request.method).toBe('POST');
      check.flush(null, { status: 202, statusText: 'Accepted' });
      await settle(fixture);
    });
  });

  describe('as a viewer who is not an admin', () => {
    beforeEach(() => configure(false));

    it('reads the list but draws none of the admin-only controls', async () => {
      const fixture = await open([runner({ quarantined: true })]);

      expect(text(fixture)).toContain('node-a');
      expect(text(fixture)).toContain('logged in');
      // The commands are reads: anyone can copy the line an operator would run.
      expect(element(fixture).querySelector('.login-command')).not.toBeNull();
      expect(element(fixture).querySelector('form')).toBeNull();
      expect(element(fixture).querySelector('.menu-toggle')).toBeNull();
      expect(text(fixture)).not.toContain('Re-check');
      expect(text(fixture)).not.toContain('Register a runner');
    });
  });
});
