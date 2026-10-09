import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BootstrapStepDto } from '../../api/bootstrap-api';
import type { BootstrapRunDto, WorkspaceRuntimeStatus } from '../../api/dto';
import { BootstrapSection, joinChain } from './bootstrap-section';

const run = (over: Partial<BootstrapRunDto> = {}): BootstrapRunDto => ({
  bootstrapCommandId: 'deps',
  commandName: 'Install dependencies',
  outcome: 'SUCCEEDED',
  commandId: 'c1',
  exitCode: 0,
  ranAt: '2026-08-01T10:00:00Z',
  ...over,
});

@Component({
  selector: 'app-section-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BootstrapSection],
  template: `<app-bootstrap-section
    [workspaceRowId]="id()"
    [runtimeStatus]="runtime()"
    [daemonConnected]="daemonConnected()"
    [visible]="visible()"
  />`,
})
class SectionHost {
  readonly id = signal(7);
  readonly visible = signal(true);
  readonly runtime = signal<WorkspaceRuntimeStatus | null>('RUNNING');
  readonly daemonConnected = signal(false);
}

/**
 * The Bootstrap section, which is two services joined by the client.
 *
 * The chain is a declaration inside the container and the last-run rows are a host table, so neither
 * side has the whole picture and the join is the feature. **`id ?? name` is the join key**: the
 * daemon defaults a step's `id` to its `name`, and the host writes that same value into
 * `bootstrapCommandId` — which is why the id is on the run row rather than only the display name.
 * `joinChain` is exported and asserted directly, because that agreement between two repositories is
 * the thing a rename will break.
 */
describe('BootstrapSection', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<SectionHost>;
  let host: SectionHost;

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

  function stepNames(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.step .name')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  async function open(
    steps: readonly BootstrapStepDto[],
    runs: readonly BootstrapRunDto[] = [],
  ): Promise<void> {
    fixture = TestBed.createComponent(SectionHost);
    host = fixture.componentInstance;
    await settle();
    http.expectOne('/workspaces/container/7/bootstrap-commands').flush({ steps });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs });
    await settle();
  }

  it('joins a step that declares an id on that id', () => {
    const rows = joinChain([{ name: 'Install dependencies', id: 'deps' }], [run()]);
    expect(rows[0].run?.commandId).toBe('c1');
  });

  it('joins a step that declares no id on its name, as the daemon’s default does', () => {
    const rows = joinChain(
      [{ name: 'deps' }],
      [run({ bootstrapCommandId: 'deps', commandName: 'deps' })],
    );
    expect(rows[0].run).not.toBeNull();
  });

  it('leaves a step with no run unjoined rather than guessing', () => {
    const rows = joinChain([{ name: 'lint' }], [run({ bootstrapCommandId: 'deps' })]);
    expect(rows[0].run).toBeNull();
  });

  it('reads two surfaces on first open: the declaration and the host’s run rows', async () => {
    fixture = TestBed.createComponent(SectionHost);
    host = fixture.componentInstance;
    await settle();

    const requests = http.match(() => true);
    expect(requests.map((request) => request.request.url).sort()).toEqual([
      '/workspaces/api/workspaces/7/bootstrap-runs',
      '/workspaces/container/7/bootstrap-commands',
    ]);
    requests[0].flush({ steps: [] });
    requests[1].flush({ runs: [] });
    await settle();
  });

  it('shows each step in declaration order with its last run', async () => {
    await open(
      [
        { name: 'Install dependencies', id: 'deps' },
        { name: 'Migrate', id: 'migrate' },
      ],
      [run({ bootstrapCommandId: 'deps' })],
    );

    expect(stepNames()).toEqual(['Install dependencies', 'Migrate']);
    expect(text()).toContain('succeeded');
    expect(text()).toContain('never ran in this workspace');
  });

  it('shows a non-zero exit code, and explains a skip', async () => {
    await open(
      [
        { name: 'Migrate', id: 'migrate' },
        { name: 'Seed', id: 'seed' },
      ],
      [
        run({ bootstrapCommandId: 'migrate', outcome: 'FAILED', exitCode: 3 }),
        run({ bootstrapCommandId: 'seed', outcome: 'SKIPPED', commandId: null, exitCode: null }),
      ],
    );

    expect(text()).toContain('exit 3');
    expect(text()).toContain('its check said it was not needed, so nothing ran');
  });

  it('keeps a run whose step the declaration no longer carries, and names it', async () => {
    await open(
      [{ name: 'Migrate', id: 'migrate' }],
      [run({ bootstrapCommandId: 'gone', commandName: 'Old step' })],
    );

    expect(text()).toContain('no matching step in the chain');
    expect(text()).toContain('Old step');
  });

  it('runs one step and re-reads the host’s rows, and says progress is not visible from here', async () => {
    await open([{ name: 'Migrate', id: 'migrate' }]);

    element().querySelector<HTMLElement>('.step qits-button button')!.click();
    await settle();

    http
      .expectOne('/workspaces/container/7/bootstrap-commands/Migrate/run')
      .flush({ accepted: true });
    await settle();
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();

    expect(text()).toContain('cannot attach to');
    expect(text()).toContain('when the platform records an outcome');
  });

  it('runs the whole chain from the header', async () => {
    await open([{ name: 'Migrate', id: 'migrate' }]);

    element().querySelector<HTMLElement>('.head qits-button button')!.click();
    await settle();

    http.expectOne('/workspaces/container/7/bootstrap-commands/run').flush({ accepted: true });
    await settle();
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();
  });

  it('names the container when the chain cannot be read, and keeps the host’s rows', async () => {
    fixture = TestBed.createComponent(SectionHost);
    host = fixture.componentInstance;
    host.runtime.set('STOPPED');
    await settle();

    http
      .expectOne('/workspaces/container/7/bootstrap-commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [run()] });
    await settle();

    expect(text()).toContain('the chain is declared in the container');
    expect(text()).toContain('survive the container');
    expect(element().querySelector('.async-error')).toBeNull();
  });

  /**
   * A runner-placed row can report `UNAVAILABLE` with its daemon still reachable through the
   * edge, independent of the runner — the chain lives in the container the daemon is attached to,
   * not on the runner's node, so it is just as runnable as it would be on a RUNNING row.
   */
  it('runs the chain on UNAVAILABLE when the daemon is still connected', async () => {
    fixture = TestBed.createComponent(SectionHost);
    host = fixture.componentInstance;
    host.runtime.set('UNAVAILABLE');
    host.daemonConnected.set(true);
    await settle();

    http.expectOne('/workspaces/container/7/bootstrap-commands').flush({
      steps: [{ name: 'Migrate', id: 'migrate' }],
    });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();

    expect(text()).not.toContain('the chain is declared in the container');
    expect(stepNames()).toEqual(['Migrate']);
    expect(
      (element().querySelector('.step qits-button button') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps UNAVAILABLE without a connected daemon reading as gone, unchanged', async () => {
    fixture = TestBed.createComponent(SectionHost);
    host = fixture.componentInstance;
    host.runtime.set('UNAVAILABLE');
    await settle();

    http
      .expectOne('/workspaces/container/7/bootstrap-commands')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http.expectOne('/workspaces/api/workspaces/7/bootstrap-runs').flush({ runs: [] });
    await settle();

    expect(text()).toContain('the chain is declared in the container');
  });
});
