import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { WorkspaceDetection } from '../../api/workspace-detection';
import { PluginsSection } from './plugins-section';

const settle = async () => {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
  }
};

@Component({
  selector: 'app-plugins-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PluginsSection],
  template: `<app-plugins-section [workspaceRowId]="id()" agentId="a1" />`,
})
class PluginsHost {
  readonly id = signal(7);
}

/**
 * The plugins section.
 *
 * Three things are asserted because each of them is a way to be quietly wrong: the install must send
 * the **bare** id (the listing reports the qualified one, and sending it back is a 400 nobody sees
 * until they press the button); the refreshed set the install answers must be *taken* rather than
 * followed by a second read; and a detection that nobody has read must cost no request here, because
 * a badge is not worth a second copy of a surface another panel owns.
 */
describe('PluginsSection', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PluginsHost>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const rows = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.plugin'));

  async function open(installed: readonly { pluginId: string; enabled: boolean }[] = []) {
    fixture = TestBed.createComponent(PluginsHost);
    fixture.detectChanges();
    http.expectOne('/workspaces/container/7/agent-plugins').flush({ installed });
    await settle();
    fixture.detectChanges();
  }

  it('reads the store once, and reads no detection of its own', async () => {
    await open();
    // The detection entry is empty and this section does ask for one — exactly one, and only
    // because nothing else has. The Files panel's read is what normally fills it.
    http.expectOne('/workspaces/container/7/agent-worktrees/a1/detection').flush({
      projects: [],
      frameworks: [],
      links: [],
      generation: 'g1',
    });
    await settle();
    http.expectNone('/workspaces/container/7/agent-worktrees/a1/detection');
  });

  it('takes a detection another panel already read rather than fetching one', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [{ root: 'webui', frameworkId: 'ts-angular', label: 'Angular' }],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open();
    http.expectNone('/workspaces/container/7/agent-worktrees/a1/detection');
    expect(rows()[0].textContent).toContain('Recommended');
    expect(rows()[0].textContent).toContain('TypeScript');
  });

  it('floats a recommendation without hiding anything else', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [{ root: 'service', frameworkId: 'java-quarkus', label: 'Quarkus' }],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open();
    expect(rows()[0].textContent).toContain('Java language server');
    expect(rows().length).toBeGreaterThan(1);
  });

  it('installs by the bare id and takes the refreshed set as the answer', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open();
    const button = rows()[0].querySelector<HTMLButtonElement>('button')!;
    button.click();
    await settle();
    http
      .expectOne('/workspaces/container/7/agent-plugins/jdtls-lsp/install')
      .flush({ installed: [{ pluginId: 'jdtls-lsp@claude-plugins-official', enabled: true }] });
    await settle();
    fixture.detectChanges();
    // No follow-up read: the install answered with the listing's own envelope.
    http.expectNone('/workspaces/container/7/agent-plugins');
    expect(rows()[0].textContent).toContain('Installed');
  });

  it('says an install failed in the daemon’s own words', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open();
    rows()[0].querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    http
      .expectOne('/workspaces/container/7/agent-plugins/jdtls-lsp/install')
      .flush({ message: 'plugins are a Claude Code feature' }, { status: 400, statusText: 'Bad' });
    await settle();
    fixture.detectChanges();
    expect(text()).toContain('plugins are a Claude Code feature');
    expect(text()).toContain('signed in');
  });

  it('lists an installed plugin it does not curate, rather than hiding it', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open([{ pluginId: 'something-else@claude-plugins-official', enabled: false }]);
    expect(text()).toContain('something-else@claude-plugins-official');
    expect(text()).toContain('switched off');
  });

  it('says the store is shared, because an install here changes every workspace', async () => {
    TestBed.inject(WorkspaceDetection).publish(
      { workspaceRowId: 7, agentId: 'a1' },
      {
        projects: [],
        frameworks: [],
        links: [],
        generation: 'g1',
      },
    );
    await open();
    expect(text()).toContain('shared agent home');
  });
});
