import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { DetectionDto, FileListingDto } from '../../api/files-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { PickedContext } from '../chat/picked-context';
import { FileNavigation } from './file-navigation';
import { isShown, type FilterLayers } from './filter-rules';
import { FilesPanel } from './files-panel';

const ROOT: FileListingDto = {
  paths: [
    'README.md',
    '.gitignore',
    'service/src/main/java/eu/wohlben/App.java',
    'service/src/test/java/eu/wohlben/AppTest.java',
    'webui/package.json',
    'webui/.gitignore',
    'webui/src/main.ts',
    'webui/src/app/app.ts',
    'webui/src/app/app.spec.ts',
    'webui/src/app/pages/home.ts',
    'webui/src/app/widgets/chip.ts',
  ],
  lazyDirs: [
    { path: 'node_modules', childCount: 312 },
    { path: 'service/target', childCount: 9 },
    { path: 'webui/dist', childCount: 3 },
  ],
  generation: 'gen-1',
};

const ANGULAR_MEMBERS = [
  'webui/package.json',
  'webui/src/main.ts',
  'webui/src/app/app.ts',
  'webui/src/app/app.spec.ts',
  'webui/src/app/pages/home.ts',
  'webui/src/app/widgets/chip.ts',
];

const detectionAt = (generation: string, links: DetectionDto['links'] = []): DetectionDto => ({
  projects: [
    { root: 'webui', frameworkId: 'angular', label: 'Angular' },
    { root: 'service', frameworkId: 'java-quarkus', label: 'Java / Quarkus' },
  ],
  frameworks: [
    { frameworkId: 'angular', root: 'webui', label: 'Angular', memberPaths: ANGULAR_MEMBERS },
    {
      frameworkId: 'java-quarkus',
      root: 'service',
      label: 'Java / Quarkus',
      memberPaths: [
        'service/src/main/java/eu/wohlben/App.java',
        'service/src/test/java/eu/wohlben/AppTest.java',
      ],
    },
  ],
  links,
  generation,
});

/** The detection with the source-to-test graph filled in, which is what the tab strip is built from. */
const LINKED = detectionAt('gen-1', [
  {
    path: 'webui/src/app/app.ts',
    projectRoot: 'webui',
    tests: [{ path: 'webui/src/app/app.spec.ts', kinds: ['unit'] }],
  },
]);

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FilesPanel],
  template: `<app-files-panel [workspaceRowId]="id()" agentId="a1" [visible]="visible()" />`,
})
class PanelHost {
  readonly id = signal(7);
  readonly visible = signal(true);
}

/** Somewhere for the router to land. Nothing renders it; it exists so a navigation can succeed. */
@Component({ selector: 'app-blank', template: '' })
class Blank {}

/**
 * The working-tree browser, in the terms the plan set it.
 *
 * **The load budget is asserted, not just written down.** `2 + D + F + I` — the whole eager tree, the
 * detection, one read per lazy directory opened, one per file opened, and one per ignore file the
 * first time an ignore-list filter is switched on. A budget that lives only in a comment grows a
 * sixth constant the first time somebody needs one, and nobody notices until a file browser is
 * fetching a level at a time.
 *
 * **The expansion distinction is asserted through the DOM as well as as arithmetic**, because it is
 * the thing the plan warns is easy to flatten by accident: a name search opens the tree fully so a
 * deep match is visible, and a framework toggle opens to a framework-sensible depth and stops.
 * Reversing either one would still look like a working file browser.
 *
 * **The precedence is asserted as a resurrection**, because that is the only observation that can
 * tell the fixed order from any other: a manual `show` brings back a file the framework's
 * default-hidden stance and an ignore file both hid. Any other layer order fails that one test and
 * passes every other.
 *
 * **A hidden panel does not refetch.** It stays mounted — the open file and the scroll position are
 * why keep-mounted exists — so without the gate a `files` hint on another tab pays for a tree nobody
 * is looking at.
 */
describe('FilesPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', component: Blank }]),
      ],
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

  function panel(): FilesPanel {
    return fixture.debugElement.children[0].componentInstance as FilesPanel;
  }

  function rowPaths(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.entry')).map(
      (entry) => entry.dataset['path'] ?? '',
    );
  }

  function entry(path: string): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.entry[data-path="${path}"]`)!;
  }

  function chip(frameworkId: string): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.chip[data-framework="${frameworkId}"]`)!;
  }

  /** The root read, in the order the panel issues it. */
  function answerRoot(
    listing: FileListingDto = ROOT,
    detection: DetectionDto | null = detectionAt('gen-1'),
  ): void {
    const files = http.expectOne(
      (request) =>
        request.url === '/workspaces/container/7/agent-worktrees/a1/files' &&
        !request.params.has('path'),
    );
    files.flush(listing);
    const detect = http.expectOne('/workspaces/container/7/agent-worktrees/a1/detection');
    if (detection) {
      detect.flush(detection);
    } else {
      detect.flush({ message: 'no' }, { status: 500, statusText: 'Server Error' });
    }
  }

  /** One `/files/content` answer, matched by the path it asked for. */
  function answerContent(path: string, content: string | null): void {
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/container/7/agent-worktrees/a1/files/content' &&
        candidate.params.get('path') === path,
    );
    request.flush(content === null ? { path, binary: true } : { path, binary: false, content });
  }

  async function open(detection: DetectionDto = detectionAt('gen-1')): Promise<void> {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();
    answerRoot(ROOT, detection);
    await settle();
  }

  async function type(query: string): Promise<void> {
    const box = element().querySelector<HTMLInputElement>('#file-filter')!;
    box.value = query;
    box.dispatchEvent(new Event('input'));
    await settle();
  }

  async function openFile(path: string, content = 'one\ntwo\nthree\n'): Promise<void> {
    entry(path).click();
    await settle();
    answerContent(path, content);
    await settle();
  }

  function lineNumbers(): string[] {
    return Array.from(element().querySelectorAll('.line .num')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  describe('the load budget', () => {
    it('reads two things on first open: the whole tree, and the detection', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      await settle();

      const requests = http.match(() => true);

      expect(requests.map((request) => request.request.urlWithParams).sort()).toEqual([
        '/workspaces/container/7/agent-worktrees/a1/detection',
        '/workspaces/container/7/agent-worktrees/a1/files',
      ]);
      for (const request of requests) {
        request.flush(request.request.url.endsWith('/detection') ? detectionAt('gen-1') : ROOT);
      }
      await settle();
    });

    it('costs one read per lazy directory opened, and nothing for the tree around it', async () => {
      await open();

      entry('node_modules').click();
      await settle();
      http
        .expectOne(
          (request) =>
            request.url === '/workspaces/container/7/agent-worktrees/a1/files' &&
            request.params.get('path') === 'node_modules',
        )
        .flush({
          paths: ['node_modules/.package-lock.json'],
          lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
          generation: 'gen-1',
        });
      await settle();

      expect(rowPaths()).toContain('node_modules/rxjs');
      expect(rowPaths()).toContain('node_modules/.package-lock.json');
    });

    it('caches a directory, so closing and re-opening it is free', async () => {
      await open();

      entry('node_modules').click();
      await settle();
      http
        .expectOne((request) => request.params.get('path') === 'node_modules')
        .flush({ paths: ['node_modules/index.js'], lazyDirs: [], generation: 'gen-1' });
      await settle();

      entry('node_modules').click();
      await settle();
      entry('node_modules').click();
      await settle();

      // No second fetch: `http.verify()` in afterEach is the assertion, and the contents are back.
      expect(rowPaths()).toContain('node_modules/index.js');
    });

    /**
     * The viewer's own budget, and the number the plan asks to see stated and asserted. One request
     * per file opened — the tab strip, the highlights and the chips are all computed from what the
     * tree already fetched.
     */
    it('costs exactly one read to open a file, and nothing else', async () => {
      await open();

      entry('README.md').click();
      await settle();

      const requests = http.match(() => true);
      expect(requests.map((request) => request.request.urlWithParams)).toEqual([
        '/workspaces/container/7/agent-worktrees/a1/files/content?path=README.md',
      ]);
      requests[0].flush({ path: 'README.md', binary: false, content: 'hello\n' });
      await settle();

      expect(lineNumbers()).toEqual(['1']);
    });
  });

  describe('the visibility gate', () => {
    it('reads nothing at all while its tab is not the one showing', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      host.visible.set(false);
      await settle();

      expect(http.match(() => true)).toEqual([]);
    });

    it('spends a hint it missed as one catch-up read on becoming visible', async () => {
      await open();

      host.visible.set(false);
      await settle();
      TestBed.inject(WorkspaceEvents).invalidateAll();
      await settle();
      expect(http.match(() => true)).toEqual([]);

      host.visible.set(true);
      await settle();
      answerRoot();
      await settle();

      expect(rowPaths()).toContain('README.md');
    });
  });

  /**
   * The distinction the plan calls out by name. Both halves are asserted here because either one
   * alone still looks like a working tree — the bug is silent, and it is the deep match nobody can
   * find that eventually reports it.
   */
  describe('the two expansions', () => {
    it('opens the tree fully for a name search, so a deep match is visible with no clicks', async () => {
      await open();
      expect(rowPaths()).not.toContain('service/src/test/java/eu/wohlben/AppTest.java');

      await type('AppTest');

      expect(panel().fullyExpanded()).toBe(true);
      expect(rowPaths()).toContain('service/src/test/java/eu/wohlben/AppTest.java');
    });

    it('opens a framework toggle only to a framework-sensible depth', async () => {
      await open();

      chip('angular').click();
      await settle();

      expect(panel().fullyExpanded()).toBe(false);
      // Down to the source directory, where the components fork and the user has a choice to make.
      expect(rowPaths()).toContain('webui/src/app');
      expect(rowPaths()).toContain('webui/src/app/pages');
      // And no further: this is browsing, not searching.
      expect(rowPaths()).not.toContain('webui/src/app/pages/home.ts');
    });

    it('opens fully again when a search composes with a framework toggle', async () => {
      await open();
      chip('angular').click();
      await settle();

      await type('home');

      expect(panel().fullyExpanded()).toBe(true);
      expect(rowPaths()).toContain('webui/src/app/pages/home.ts');
    });

    it('keeps where the user was browsing when the framework toggle goes off again', async () => {
      await open();
      chip('angular').click();
      await settle();

      chip('angular').click();
      await settle();

      // The seed was written into the expansion set rather than applied as an override, so turning
      // the toggle off does not snap shut the directory the user has been reading.
      expect(rowPaths()).toContain('webui/src/app');
    });

    /** A hand-written rule is a search too — the policy `NarrowingKind` has carried since the tree. */
    it('opens fully for a manual rule, which is a search by another name', async () => {
      await open();

      panel().rules.set([
        { id: 'r1', kind: 'includes', query: 'home', mode: 'show', enabled: true },
      ]);
      await settle();

      expect(panel().fullyExpanded()).toBe(true);
    });
  });

  describe('the tree itself', () => {
    it('labels a lazy directory with its immediate child count and dims it', async () => {
      await open();

      expect(entry('node_modules').textContent).toContain('(312)');
      expect(entry('node_modules').closest('.row')?.classList.contains('ignored')).toBe(true);
    });

    it('folds a single-child chain into one breadcrumb row', async () => {
      await open();

      entry('service').click();
      await settle();
      entry('service/src').click();
      await settle();

      const chain = entry('service/src/main/java/eu/wohlben');
      expect(chain).toBeTruthy();
      expect(chain.querySelector('.prefix')?.textContent).toContain('main');
      expect(chain.querySelector('.name')?.textContent?.trim()).toBe('wohlben');
    });

    it('does not let a folder steal the selection from the open file', async () => {
      await open();

      await openFile('README.md');
      expect(panel().selectedPath()).toBe('README.md');

      entry('webui').click();
      await settle();

      expect(panel().selectedPath()).toBe('README.md');
    });
  });

  describe('the footers', () => {
    it('says how many collapsed directories the filter could not look inside', async () => {
      await open();
      expect(element().querySelector('.unsearched')).toBeNull();

      await type('zzzz');

      expect(element().querySelector('.unsearched')?.textContent).toContain(
        '3 collapsed directories not searched',
      );
    });

    it('says nothing matched, beside the directories it could not search', async () => {
      await open();

      await type('zzzz');

      expect(element().textContent).toContain('No files match.');
      expect(element().querySelector('.unsearched')).not.toBeNull();
    });

    it('offers one quick-access toggle per detected framework kind', async () => {
      await open();

      const labels = Array.from(element().querySelectorAll('.chip')).map((node) =>
        node.textContent?.trim(),
      );

      expect(labels).toEqual(['Angular', 'Java / Quarkus']);
    });
  });

  /**
   * `/files` and `/detection` are two independently-fetched views over one mutable tree, so a skew is
   * normal. Applying a detection to a tree it was not computed from makes the footer flicker in a way
   * that is very hard to diagnose later, and blanking it does the same thing more loudly.
   */
  describe('the generation gate', () => {
    it('does not apply a detection computed from a different tree', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      await settle();
      answerRoot(ROOT, detectionAt('gen-2'));
      await settle();

      expect(element().querySelectorAll('.chip').length).toBe(0);
      expect(rowPaths()).toContain('README.md');
    });

    it('holds the last consistent detection rather than blanking it on a mismatch', async () => {
      await open();
      expect(element().querySelectorAll('.chip').length).toBe(2);

      TestBed.inject(WorkspaceEvents).invalidateAll();
      await settle();
      answerRoot({ ...ROOT, generation: 'gen-3' }, detectionAt('gen-1'));
      await settle();

      // The tree moved to gen-3 and the detection still describes gen-1, so the footer holds what it
      // had. The next tick resolves it; a blank footer in the meantime would read as "no frameworks".
      expect(element().querySelectorAll('.chip').length).toBe(2);
    });
  });

  /**
   * The fixed precedence, asserted the only way it can be told apart from any other order: by the
   * resurrection it is there to guarantee.
   */
  describe('the rule layers', () => {
    it('costs one read per ignore file, once, when an ignore list is switched on', async () => {
      await open();

      panel().toggleIgnore('.gitignore');
      await settle();

      const requests = http.match(() => true);
      // Shallow to deep, which is also the order the layer is built in.
      expect(requests.map((request) => request.request.params.get('path'))).toEqual([
        '.gitignore',
        'webui/.gitignore',
      ]);
      requests[0].flush({ path: '.gitignore', binary: false, content: '*.md\n' });
      requests[1].flush({ path: 'webui/.gitignore', binary: false, content: 'dist/\n' });
      await settle();

      expect(rowPaths()).not.toContain('README.md');

      // Off and on again is free: the text is cached for the generation.
      panel().toggleIgnore('.gitignore');
      await settle();
      panel().toggleIgnore('.gitignore');
      await settle();
      expect(rowPaths()).not.toContain('README.md');
    });

    it('scopes an ignore file to its own directory and lets the deeper one have the last word', async () => {
      await open();

      panel().toggleIgnore('.gitignore');
      await settle();
      http
        .expectOne((request) => request.params.get('path') === '.gitignore')
        .flush({ path: '.gitignore', binary: false, content: '*.ts\n' });
      http
        .expectOne((request) => request.params.get('path') === 'webui/.gitignore')
        .flush({ path: 'webui/.gitignore', binary: false, content: '!src/main.ts\n' });
      await settle();

      const shown = panel().layers();
      // The root rule hid every `.ts`; the nested negation brought one back, and only under `webui`.
      expect(visibleUnder(shown, 'webui/src/main.ts')).toBe(true);
      expect(visibleUnder(shown, 'webui/src/app/app.ts')).toBe(false);
      // And it never reached the service tree, which has no `.gitignore` of its own.
      expect(visibleUnder(shown, 'service/src/main/java/eu/wohlben/App.java')).toBe(true);
    });

    it('lets a manual show resurrect what the framework and the ignore list both hid', async () => {
      await open();

      chip('java-quarkus').click();
      await settle();
      panel().toggleIgnore('.gitignore');
      await settle();
      http
        .expectOne((request) => request.params.get('path') === '.gitignore')
        .flush({ path: '.gitignore', binary: false, content: 'README.md\n' });
      http
        .expectOne((request) => request.params.get('path') === 'webui/.gitignore')
        .flush({ path: 'webui/.gitignore', binary: false, content: '' });
      await settle();

      // Hidden twice over: outside the framework's whitelist, and named by the root ignore file.
      expect(rowPaths()).not.toContain('README.md');

      panel().rules.set([
        { id: 'r1', kind: 'exact', query: 'README.md', mode: 'show', enabled: true },
      ]);
      await settle();

      expect(rowPaths()).toContain('README.md');
    });

    it('keeps a disabled rule in its place rather than dropping it', async () => {
      await open();

      panel().rules.set([
        { id: 'r1', kind: 'includes', query: '.ts', mode: 'hide', enabled: true },
        { id: 'r2', kind: 'exact', query: 'main.ts', mode: 'show', enabled: false },
      ]);
      await settle();
      expect(rowPaths()).not.toContain('webui/src/main.ts');

      panel().rules.update((rules) =>
        rules.map((rule) => (rule.id === 'r2' ? { ...rule, enabled: true } : rule)),
      );
      await settle();

      expect(rowPaths()).toContain('webui/src/main.ts');
    });
  });

  /** The strip is normalised through the owning source, so either member shows the same tabs. */
  describe('the test and code tabs', () => {
    it('shows the same strip whichever member is open', async () => {
      await open(LINKED);

      await type('app');
      await openFile('webui/src/app/app.ts');
      expect(memberPaths()).toEqual(['webui/src/app/app.ts', 'webui/src/app/app.spec.ts']);

      await openFile('webui/src/app/app.spec.ts');
      expect(memberPaths()).toEqual(['webui/src/app/app.ts', 'webui/src/app/app.spec.ts']);
      expect(
        element().querySelector('.member[data-member="webui/src/app/app.spec.ts"]')?.textContent,
      ).toContain('app');
    });

    it('hides a reachable test from the tree, and gives it back while name-searching', async () => {
      await open(LINKED);

      chip('angular').click();
      await settle();
      expect(rowPaths()).not.toContain('webui/src/app/app.spec.ts');

      await type('app.spec');

      expect(rowPaths()).toContain('webui/src/app/app.spec.ts');
    });
  });

  /**
   * Both entry points, and the property that separates them: one takes the path at its word, the
   * other admits the path may be wrong and shows its working.
   */
  describe('the two entry points', () => {
    it('opens at an exact range, for a file that is not in the tree at all', async () => {
      await open();

      TestBed.inject(FileNavigation).openAt('service/target/build.log', {
        startLine: 2,
        endLine: 3,
      });
      await settle();
      answerContent('service/target/build.log', 'a\nb\nc\nd\n');
      await settle();

      // Not a row anywhere — it lives under a lazy directory nobody opened — and open regardless.
      expect(rowPaths()).not.toContain('service/target/build.log');
      expect(panel().selectedPath()).toBe('service/target/build.log');
      expect(anchoredLines()).toEqual(['2', '3']);
    });

    it('seeds the name filter with a stale path, so the user can see why the tree is narrowed', async () => {
      await open();

      TestBed.inject(FileNavigation).openClosest('webui/src/app/widgets/chip.ts');
      await settle();
      answerContent('webui/src/app/widgets/chip.ts', 'chip\n');
      await settle();

      const box = element().querySelector<HTMLInputElement>('#file-filter')!;
      expect(box.value).toBe('webui/src/app/widgets/chip.ts');
      expect(panel().selectedPath()).toBe('webui/src/app/widgets/chip.ts');
      // The parameter is spent, so the URL says what was opened rather than what was guessed from.
      expect(TestBed.inject(Router).url).not.toContain('near=');
    });

    it('leaves the seeded filter standing and selects nothing when nothing is plausible', async () => {
      await open();

      TestBed.inject(FileNavigation).openClosest('some/other/repository/thing.rs');
      await settle();

      expect(element().querySelector<HTMLInputElement>('#file-filter')!.value).toBe(
        'some/other/repository/thing.rs',
      );
      expect(panel().selectedPath()).toBeNull();
      expect(element().textContent).toContain('No files match.');
    });
  });

  /** Picking writes to the seam the prompt panel reads, and paints what it wrote. */
  describe('line picking', () => {
    it('collects a range as a code reference, with the lines it stood for', async () => {
      await open();
      await openFile('README.md', 'alpha\nbeta\ngamma\n');

      element().querySelector<HTMLButtonElement>('.pick')!.click();
      await settle();
      gutter(1).click();
      await settle();
      gutter(2).click();
      await settle();

      expect(TestBed.inject(PickedContext).references()).toEqual([
        { path: 'README.md', startLine: 1, endLine: 2, excerpt: 'alpha\nbeta' },
      ]);
      expect(element().querySelector('.chips')?.textContent).toContain('1-2');
      expect(pickedLines()).toEqual(['1', '2']);
    });

    it('stays armed across picks and disarms when the file changes', async () => {
      await open();
      await openFile('README.md', 'alpha\nbeta\ngamma\n');

      element().querySelector<HTMLButtonElement>('.pick')!.click();
      await settle();
      gutter(1).click();
      await settle();
      gutter(1).click();
      await settle();
      gutter(3).click();
      await settle();
      gutter(3).click();
      await settle();

      expect(TestBed.inject(PickedContext).references().length).toBe(2);
      expect(panel().picking()).toBe(true);

      await type('main.ts');
      await openFile('webui/src/main.ts', 'x\n');

      expect(panel().picking()).toBe(false);
      expect(element().querySelectorAll('.line .num button').length).toBe(0);
    });
  });

  describe('the viewer', () => {
    it('says a file is too large or binary, because the daemon sends both the same way', async () => {
      await open();

      entry('README.md').click();
      await settle();
      answerContent('README.md', null);
      await settle();

      expect(element().querySelector('.unrenderable')?.textContent).toContain(
        'too large or binary',
      );
    });

    it('tells an empty file from an unrenderable one', async () => {
      await open();

      await openFile('README.md', '');

      expect(element().querySelector('.unrenderable')?.textContent).toContain(
        'This file is empty.',
      );
    });

    it('says what to do before a file is open', async () => {
      await open();

      expect(element().textContent).toContain('Select a file to view its contents.');
    });
  });

  // ---- helpers -----------------------------------------------------------------------------

  function memberPaths(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.member')).map(
      (node) => node.dataset['member'] ?? '',
    );
  }

  function gutter(line: number): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.line[data-line="${line}"] .num`)!;
  }

  function anchoredLines(): string[] {
    return Array.from(element().querySelectorAll('.line.anchored')).map(
      (node) => (node as HTMLElement).dataset['line'] ?? '',
    );
  }

  function pickedLines(): string[] {
    return Array.from(element().querySelectorAll('.line.picked')).map(
      (node) => (node as HTMLElement).dataset['line'] ?? '',
    );
  }

  function visibleUnder(layers: FilterLayers, path: string): boolean {
    return isShown(path, layers);
  }
});
