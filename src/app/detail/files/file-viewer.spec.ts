import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { WorkspaceEvents } from '../../api/workspace-events';
import { FileViewer, type LineRange, type PickedRange } from './file-viewer';

@Component({
  selector: 'app-viewer-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FileViewer],
  template: `
    <app-file-viewer
      [workspaceRowId]="7"
      agentId="a1"
      [path]="path()"
      [visible]="visible()"
      [picking]="picking()"
      [anchor]="anchor()"
      [knownBytes]="knownBytes()"
      (pick)="picked.set($event)"
    />
  `,
})
class ViewerHost {
  readonly path = signal<string | null>('README.md');
  readonly visible = signal(true);
  readonly picking = signal(false);
  readonly anchor = signal<LineRange | null>(null);
  readonly knownBytes = signal<number | null>(null);
  readonly picked = signal<PickedRange | null>(null);
}

/**
 * The viewer on its own, for the two things the panel's spec cannot see: the shift gesture, and the
 * copy that changes the day a file's size becomes knowable.
 */
describe('FileViewer', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<ViewerHost>;
  let host: ViewerHost;

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

  function answer(body: Record<string, unknown>): void {
    http
      .expectOne(
        (request) => request.url === '/workspaces/container/7/agent-worktrees/a1/files/content',
      )
      .flush(body);
  }

  async function open(content = 'alpha\nbeta\ngamma\ndelta\n'): Promise<void> {
    fixture = TestBed.createComponent(ViewerHost);
    host = fixture.componentInstance;
    await settle();
    answer({ path: 'README.md', binary: false, content });
    await settle();
  }

  function gutter(line: number): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.line[data-line="${line}"] .num`)!;
  }

  it('numbers every line and does not invent one for a trailing newline', async () => {
    await open();

    expect(
      Array.from(element().querySelectorAll('.line')).map(
        (node) => (node as HTMLElement).dataset['line'],
      ),
    ).toEqual(['1', '2', '3', '4']);
  });

  it('reads nothing while the tab is hidden', async () => {
    fixture = TestBed.createComponent(ViewerHost);
    host = fixture.componentInstance;
    host.visible.set(false);
    await settle();

    expect(http.match(() => true)).toEqual([]);
  });

  it('re-reads on a files hint, because the agent is editing the file you are reading', async () => {
    await open();

    TestBed.inject(WorkspaceEvents).invalidateAll();
    await settle();
    answer({ path: 'README.md', binary: false, content: 'changed\n' });
    await settle();

    expect(element().textContent).toContain('changed');
  });

  it('takes one shift-click as a whole range from wherever the first end was', async () => {
    await open();
    host.picking.set(true);
    await settle();

    gutter(2).click();
    await settle();
    gutter(4).dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    await settle();

    expect(host.picked()).toEqual({ startLine: 2, endLine: 4, excerpt: 'beta\ngamma\ndelta' });
  });

  it('captures the excerpt at pick time, so a later edit cannot rewrite what was chosen', async () => {
    await open();
    host.picking.set(true);
    await settle();
    gutter(1).click();
    await settle();
    gutter(1).click();
    await settle();

    TestBed.inject(WorkspaceEvents).invalidateAll();
    await settle();
    answer({ path: 'README.md', binary: false, content: 'rewritten\n' });
    await settle();

    expect(host.picked()?.excerpt).toBe('alpha');
  });

  it('offers no gutter buttons while pick mode is off', async () => {
    await open();

    expect(element().querySelectorAll('.line .num button').length).toBe(0);
    expect(element().querySelectorAll('button.num').length).toBe(0);
  });

  it('paints the anchored range and nothing else', async () => {
    await open();
    host.anchor.set({ startLine: 2, endLine: 3 });
    await settle();

    expect(
      Array.from(element().querySelectorAll('.line.anchored')).map(
        (node) => (node as HTMLElement).dataset['line'],
      ),
    ).toEqual(['2', '3']);
  });

  /**
   * The copy rule the contract asks for. Unset — which is every case today — it names both
   * possibilities; set, it says which one happened. Guessing from the extension instead would be a
   * claim nobody checked.
   */
  describe('the unrenderable copy', () => {
    it('names both possibilities when the size is unknown', async () => {
      fixture = TestBed.createComponent(ViewerHost);
      host = fixture.componentInstance;
      await settle();
      answer({ path: 'README.md', binary: true });
      await settle();

      expect(element().querySelector('.unrenderable')?.textContent).toContain(
        'too large or binary',
      );
    });

    it('says which one it was when the size is knowable', async () => {
      fixture = TestBed.createComponent(ViewerHost);
      host = fixture.componentInstance;
      host.knownBytes.set(3 * 1024 * 1024);
      await settle();
      answer({ path: 'README.md', binary: true });
      await settle();

      expect(element().querySelector('.unrenderable')?.textContent).toContain(
        'over the 2 MB read limit',
      );

      host.knownBytes.set(1024);
      await settle();
      expect(element().querySelector('.unrenderable')?.textContent).toContain('is binary');
    });
  });

  it('drops a late answer for a file nobody is reading any more', async () => {
    fixture = TestBed.createComponent(ViewerHost);
    host = fixture.componentInstance;
    await settle();
    const first = http.expectOne((request) => request.params.get('path') === 'README.md');

    host.path.set('other.ts');
    await settle();
    http
      .expectOne((request) => request.params.get('path') === 'other.ts')
      .flush({ path: 'other.ts', binary: false, content: 'second\n' });
    await settle();

    first.flush({ path: 'README.md', binary: false, content: 'first\n' });
    await settle();

    expect(element().textContent).toContain('second');
    expect(element().textContent).not.toContain('first');
  });
});
