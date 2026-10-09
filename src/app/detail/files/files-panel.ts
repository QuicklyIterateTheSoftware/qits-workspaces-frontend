import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import type { DetectionDto, FileListingDto } from '../../api/files-api';
import { FilesApi } from '../../api/files-api';
import { WorkspaceDetection } from '../../api/workspace-detection';
import { WorkspaceEvents } from '../../api/workspace-events';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';
import { PickedContext, referenceLabel, type CodeReference } from '../chat/picked-context';
import { FileNavigation, closestMatch, formatRange, parseRange } from './file-navigation';
import { FileTree } from './file-tree';
import { FileViewer, type LineRange, type PickedRange } from './file-viewer';
import { FilterDialog, type GeneratedSet } from './filter-dialog';
import {
  compileAll,
  frameworkWhitelist,
  hideSet,
  previewOf,
  type CompiledRule,
  type FilterLayers,
  type FilterRule,
} from './filter-rules';
import { IGNORE_BASENAMES, ignoreLayer, ignoreSources } from './ignore-list';
import { buildGroups, reachableTests, tabLabel, type FileGroup } from './test-links';
import {
  EMPTY_NODE,
  applyDetection,
  buildTree,
  expandsFully,
  filePaths,
  flatten,
  frameworkSeed,
  unsearchedLazyDirs,
  visiblePaths,
  type NarrowingKind,
  type TreeRow,
} from './tree-model';

/** One button in the framework footer: a framework *kind*, however many roots declare it. */
export interface FrameworkToggle {
  readonly frameworkId: string;
  readonly label: string;
}

/**
 * The working-tree browser: a tree on the left, a read-only viewer on the right, and the filters
 * that decide what is in the tree.
 *
 * ## What it loads
 *
 * **On first open this panel reads `2`, and then `D + F + I` as you use it:**
 *
 * 1. `GET /files` — the *whole* eager tree in one answer, at full depth, plus every wholly-ignored
 *    directory as a stub. The tree is not fetched a level at a time; only the ignored parts are.
 * 2. `GET /detection` — the frameworks the footer toggles, the source-to-test graph the viewer's tab
 *    strip is built from, and the token that gates both.
 * 3. `D` — `GET /files?path=…` once per lazy directory opened, cached per directory, so re-expanding
 *    one is free for the rest of the generation.
 * 4. `F` — `GET /files/content?path=…` **once per file opened**, and once more each time a `files`
 *    hint lands while this tab is showing. The viewer does not cache: a tree an agent is rewriting
 *    has no business showing yesterday's bytes.
 * 5. `I` — one `GET /files/content` per ignore file, the first time an ignore-list filter is turned
 *    on, cached for the generation. Turning it off and on again is free.
 *
 * Nothing else costs a request. The test/code strip, the framework whitelists, the highlights and
 * the dialog's live preview are all computed from what is already in hand.
 *
 * **It does not poll and it does not refetch while hidden.** A `files` hint arriving on another tab
 * is recorded and spent as one catch-up read when this tab is next shown — the panel stays mounted
 * (its open file and scroll position are the reason keep-mounted exists), so refetching in the
 * background would pay for a tree nobody is looking at.
 *
 * ## The two expansions, which are not the same expansion
 *
 * This is the decision most easily flattened by accident, so it is stated twice — here and in
 * `tree-model.ts`:
 *
 * - **A name search, or a manual filter rule, opens the tree fully.** It is a search; a match four
 *   directories down is the answer, and leaving it behind a closed folder makes the box useless.
 * - **A framework toggle opens to a framework-sensible depth.** It is browsing; it seeds the
 *   expansion at the framework's root and follows the unambiguous run beneath it, then stops. Opening
 *   everything would be jarring and is not what "show me the Angular app" asks for.
 *
 * An **ignore list** is neither: it takes noise out of a tree you were already looking at, so it
 * changes what is shown and never how far it opens.
 *
 * ## Rule precedence, which is fixed
 *
 * **framework → ignore-list → manual**, one ordered list, last match wins. A framework restriction
 * sets a default-hidden stance and whitelists its members; the ignore lists and the reachable-test
 * hide subtract; the manual rules go last, **so a manual `show` can always resurrect a file
 * something else hid.** See `filter-rules.ts`, which is where the order is written down once.
 *
 * ## The two entry points
 *
 * Both are URL parameters, read by an `effect` and never by a click, which is what makes a deep link,
 * the back button and a press behave identically:
 *
 * - `?path=…&lines=12-20` — **open at an exact range.** The path is taken at its word and is not
 *   looked for in the tree, because `/files/content` consults git for nothing: a log file that is not
 *   in the listing at all opens exactly as well as a tracked one, and that is the case this exists
 *   for.
 * - `?near=…` — **open the closest match to a possibly stale path.** It seeds the name filter with
 *   that path *exactly as if the user had typed it*, so the tree narrows and expands and the user can
 *   see **why**, and then selects the closest match among what survived. No plausible match leaves
 *   the seeded filter standing and selects nothing.
 */
@Component({
  selector: 'app-files-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, FileTree, FileViewer, FilterDialog],
  templateUrl: './files-panel.html',
  styleUrl: './files-panel.css',
})
export class FilesPanel {
  private readonly filesApi = inject(FilesApi);
  private readonly shared = inject(WorkspaceDetection);
  private readonly events = inject(WorkspaceEvents);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly nav = inject(FileNavigation);
  protected readonly picked = inject(PickedContext);

  /** Which workspace's container to read. The row id, which is what the proxy addresses. */
  readonly workspaceRowId = input.required<number>();

  /**
   * Whether this tab is the one showing.
   *
   * The panel is mounted whether or not it is — that is the tab contract — so this is what stops it
   * refetching behind another tab. It is an input rather than something read from a host, because
   * the policy differs per panel: Chat and Agents keep working while hidden and this one must not.
   */
  readonly visible = input(false);

  private readonly query$ = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  /**
   * The open file, straight off the URL.
   *
   * It is the URL rather than a local signal because opening a file costs a request — the house rule
   * is that expensive state is addressable state — and because it is what makes the two entry points
   * ordinary rather than special: an "open in source" from the Agents tab is the same navigation a
   * tree click makes.
   */
  readonly selectedPath = computed(() => this.query$().get('path'));

  /** The deep link's range: painted and scrolled to, and distinct from the picked ranges. */
  protected readonly anchor = computed<LineRange | null>(() =>
    parseRange(this.query$().get('lines')),
  );

  protected readonly listing = signal<Loadable<FileListingDto>>(IDLE);

  /** One entry per opened lazy directory. Cleared only when the tree's generation moves. */
  private readonly opened = signal<ReadonlyMap<string, FileListingDto>>(new Map());

  protected readonly pending = signal<ReadonlySet<string>>(new Set<string>());

  /** The newest detection answer, whatever tree it describes. */
  private readonly incoming = signal<DetectionDto | null>(null);

  /** The newest detection that matched the tree on screen. Held across a mismatch, never blanked. */
  private readonly held = signal<DetectionDto | null>(null);

  /** The filter box. Free — it costs no request — so it is a local signal and not a URL parameter. */
  readonly query = signal('');

  /** Which framework *kinds* are toggled on. Several compose as a union. */
  readonly activeFrameworks = signal<ReadonlySet<string>>(new Set<string>());

  /** The advanced dialog's ordered rules. */
  readonly rules = signal<readonly FilterRule[]>([]);

  /** Which ignore-file basenames are being applied. */
  readonly activeIgnores = signal<ReadonlySet<string>>(new Set<string>());

  /** Ignore files already read, keyed by path. Dropped with the generation, like the directory cache. */
  private readonly ignoreText = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly dialogOpen = signal(false);

  /**
   * Whether pick mode is armed.
   *
   * **Sticky across picks**: picking three ranges out of one file is the normal case, and re-arming
   * between them would be three extra clicks in the middle of reading. It disarms on a file change,
   * because the mode was about *this* file and a still-armed gutter in the next one turns a stray
   * click into a reference nobody asked for.
   */
  readonly picking = signal(false);

  private readonly expanded = signal<ReadonlySet<string>>(new Set<string>());

  private readonly fileHints = this.events.invalidations('files');

  private loadedFor: number | null = null;
  private resetFor: number | null = null;
  private seenHint = -1;
  private missedHint = false;
  private readingIgnores = new Set<string>();
  private consumedNear: string | null = null;

  constructor() {
    // Driven off the id and the hint, gated on visibility — never off a click, so a deep link and a
    // press behave identically.
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const hint = this.fileHints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, hint, visible));
    });

    // The generation gate. It writes rather than computes because holding the last consistent answer
    // is state: a computed would have to recompute it from an input that no longer exists.
    effect(() => {
      const incoming = this.incoming();
      const generation = this.generation();
      untracked(() => {
        const next = applyDetection(this.held(), incoming, generation);
        if (next !== this.held()) {
          this.held.set(next);
        }
      });
    });

    // The ignore files, read when a list is switched on and never before. The tree paths are a
    // dependency because a file that appears later can be a `.gitignore` too.
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const active = this.activeIgnores();
      const paths = this.allPaths();
      untracked(() => this.readIgnoreFiles(workspaceRowId, active, paths));
    });

    // The closest-match entry point. It is consumed once and the parameter is cleared, so the URL
    // settles on the file that was opened rather than on the guess it came from — and so a later
    // jump to the same stale path is a fresh request rather than a no-op.
    effect(() => {
      const near = this.query$().get('near');
      const paths = this.allPaths();
      untracked(() => this.resolveNear(near, paths));
    });

    // Pick mode was about the file it was armed in.
    effect(() => {
      this.selectedPath();
      untracked(() => this.picking.set(false));
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  /** The tree's own token. Everything gated on a generation is gated on this one. */
  protected readonly generation = computed(() => {
    const state = this.listing();
    return state.kind === 'ready' ? state.value.generation : '';
  });

  protected readonly tree = computed(() => {
    const state = this.listing();
    return state.kind === 'ready' ? buildTree(state.value, this.opened()) : EMPTY_NODE;
  });

  /** Every file path the tree knows about. The input to every filter and to the closest-match search. */
  private readonly allPaths = computed(() => filePaths(this.tree()));

  private readonly openedPaths = computed<ReadonlySet<string>>(() => new Set(this.opened().keys()));

  /** The enabled manual rules, compiled. Also what tells {@link narrowing} a search is on. */
  private readonly manualRules = computed(() => compileAll(this.rules()));

  /** Why the tree is narrowed, which decides how far it opens. */
  protected readonly narrowing = computed<readonly NarrowingKind[]>(() => {
    const kinds: NarrowingKind[] = [];
    if (this.query().trim() !== '') {
      kinds.push('name-search');
    }
    if (this.manualRules().length > 0) {
      kinds.push('manual-rule');
    }
    if (this.activeFrameworks().size > 0) {
      kinds.push('framework');
    }
    return kinds;
  });

  /** True while a search is on. Public because it is the assertion the expansion rule is worth. */
  readonly fullyExpanded = computed(() => expandsFully(this.narrowing()));

  /** Every framework kind the detection found, deduplicated — one toggle per kind, not per root. */
  protected readonly frameworkToggles = computed<readonly FrameworkToggle[]>(() => {
    const seen = new Map<string, FrameworkToggle>();
    for (const membership of this.held()?.frameworks ?? []) {
      if (!seen.has(membership.frameworkId)) {
        seen.set(membership.frameworkId, {
          frameworkId: membership.frameworkId,
          label: membership.label,
        });
      }
    }
    return [...seen.values()];
  });

  /**
   * The union of every active framework's members, or null when none is on.
   *
   * A whitelist over the server's membership set rather than a path prefix: a framework's files are
   * not always all under its root, and a nested sibling project under one would be swept in by a
   * prefix test.
   */
  private readonly memberSet = computed<ReadonlySet<string> | null>(() => {
    const active = this.activeFrameworks();
    if (active.size === 0) {
      return null;
    }
    const union = new Set<string>();
    for (const membership of this.held()?.frameworks ?? []) {
      if (active.has(membership.frameworkId)) {
        for (const path of membership.memberPaths) {
          union.add(path);
        }
      }
    }
    return union;
  });

  /** The source-to-test graph, normalised so any member resolves to its owning source's group. */
  private readonly groups = computed<ReadonlyMap<string, FileGroup>>(() =>
    buildGroups(this.held()?.links ?? []),
  );

  /** The strip above the viewer: the Code tab, then one tab per linked test. */
  protected readonly group = computed<FileGroup | null>(() => {
    const path = this.selectedPath();
    return path ? (this.groups().get(path) ?? null) : null;
  });

  /**
   * The reachable-test hide, or nothing while the name box has text in it.
   *
   * A test one click from its source is a second row saying the same thing, and in a Maven or an
   * Angular layout that is half the tree. But a *search* is the user asking where something is, and
   * answering "not here" about a file that exists would be the tree lying — so the hide lifts the
   * moment the box is used.
   */
  private readonly hiddenTests = computed<readonly CompiledRule[]>(() => {
    if (this.query().trim() !== '') {
      return [];
    }
    const tests = reachableTests(this.held()?.links ?? []);
    return tests.size === 0 ? [] : [hideSet(tests, 'hide · tests reachable from their source')];
  });

  /** The ignore-file rules, in the shallow-to-deep order that gives the nearest file the last word. */
  private readonly ignoreRules = computed<readonly CompiledRule[]>(() => {
    const rules: CompiledRule[] = [];
    for (const name of this.activeIgnores()) {
      rules.push(...ignoreLayer(ignoreSources(this.allPaths(), name), this.ignoreText()));
    }
    return rules;
  });

  /** The three layers, in the one order they are ever evaluated in. Public because it is the assertion. */
  readonly layers = computed<FilterLayers>(() => {
    const members = this.memberSet();
    const framework: CompiledRule[] = [];
    if (members !== null) {
      for (const membership of this.held()?.frameworks ?? []) {
        if (this.activeFrameworks().has(membership.frameworkId)) {
          framework.push(frameworkWhitelist(new Set(membership.memberPaths), membership.label));
        }
      }
    }
    return {
      defaultHidden: members !== null,
      framework,
      ignoreList: [...this.ignoreRules(), ...this.hiddenTests()],
      manual: this.manualRules(),
    };
  });

  /** The file paths that survive the narrowing, or null when nothing narrows. */
  private readonly matched = computed(() =>
    visiblePaths(this.allPaths(), this.query(), this.layers()),
  );

  protected readonly rows = computed<readonly TreeRow[]>(() =>
    flatten(this.tree(), {
      expanded: this.expanded(),
      fullyExpanded: this.fullyExpanded(),
      visible: this.matched(),
      opened: this.openedPaths(),
    }),
  );

  /** What the dialog prints: the truth about the tree, capped at 500 with an honest count. */
  protected readonly preview = computed(() =>
    previewOf(this.allPaths(), this.layers(), this.query()),
  );

  /**
   * The framework rows in the dialog: one per *kind*, matching the footer.
   *
   * Two roots declaring the same framework are one toggle, so they must be one row — two rows over
   * one switch would flip together and read as a bug in the checkbox.
   */
  protected readonly frameworkSets = computed<readonly GeneratedSet[]>(() => {
    const byKind = new Map<string, { label: string; roots: string[]; members: number }>();
    for (const membership of this.held()?.frameworks ?? []) {
      const entry = byKind.get(membership.frameworkId) ?? {
        label: membership.label,
        roots: [],
        members: 0,
      };
      entry.roots.push(membership.root || 'the root');
      entry.members += membership.memberPaths.length;
      byKind.set(membership.frameworkId, entry);
    }
    return [...byKind.entries()].map(([frameworkId, entry]) => ({
      id: frameworkId,
      name: entry.label,
      on: this.activeFrameworks().has(frameworkId),
      note: `${entry.members} paths under ${entry.roots.join(', ')}`,
      rules: [`show · whitelist of ${entry.members} server-resolved member paths`],
    }));
  });

  /**
   * The ignore-list rows.
   *
   * A basename with no files in the tree is dropped, unless it is switched on — a toggle that
   * vanishes when the tree changes under it would take its own state with it.
   */
  protected readonly ignoreSets = computed<readonly GeneratedSet[]>(() =>
    IGNORE_BASENAMES.map((name) => {
      const sources = ignoreSources(this.allPaths(), name);
      const on = this.activeIgnores().has(name);
      return {
        id: name,
        name,
        on,
        count: sources.length,
        note: `${sources.length} ${sources.length === 1 ? 'file' : 'files'} in the tree`,
        rules: on
          ? ignoreLayer(sources, this.ignoreText()).map((rule) => `${rule.mode} · ${rule.label}`)
          : [],
      };
    }).filter((set) => set.count > 0 || set.on),
  );

  /** The ranges picked in the file that is open — the chips, and the paint. */
  protected readonly picksHere = computed<readonly CodeReference[]>(() => {
    const path = this.selectedPath();
    return path ? this.picked.references().filter((reference) => reference.path === path) : [];
  });

  /**
   * How many stubs the filter could not look inside.
   *
   * Shown only while something narrows, because with no filter "collapsed" is just the tree being
   * collapsed. With one, the line is what stops "No files match." from being a lie about every
   * ignored directory in the repository.
   */
  protected readonly unsearched = computed(() =>
    this.narrowing().length === 0 ? 0 : unsearchedLazyDirs(this.tree(), this.openedPaths()),
  );

  /**
   * Nothing matched — said about *files*, not about rows.
   *
   * The distinction is load-bearing because an unopened stub stays visible under a filter, so a
   * search that found nothing still renders three collapsed directories. Counting rows would
   * therefore never reach zero and the sentence would never appear, on exactly the tree where it is
   * needed most. With no filter at all it means the workspace holds no files, which is a different
   * true thing said the same way.
   */
  protected readonly noMatch = computed(() => {
    if (this.listing().kind !== 'ready') {
      return false;
    }
    const matched = this.matched();
    return matched === null ? this.allPaths().length === 0 : matched.size === 0;
  });

  protected isFrameworkOn(frameworkId: string): boolean {
    return this.activeFrameworks().has(frameworkId);
  }

  protected label(reference: CodeReference): string {
    return referenceLabel(reference);
  }

  protected tabLabelOf(path: string): string {
    return tabLabel(path);
  }

  // ---- what the panel does -----------------------------------------------------------------

  protected onQuery(value: string): void {
    this.query.set(value);
  }

  /** A file was chosen. It goes in the URL, which is what then opens it. */
  protected onOpenFile(path: string): void {
    this.nav.openAt(path);
  }

  /**
   * A directory row was pressed.
   *
   * An unopened lazy directory costs one request; everything else is free. The selection is never
   * touched — toggling a folder while reading a file must not lose the user's place.
   */
  protected onToggleDir(row: TreeRow): void {
    const node = row.node;
    if (node.kind === 'lazy' && !this.openedPaths().has(node.path)) {
      void this.openLazyDir(node.path);
      return;
    }
    if (this.fullyExpanded() && node.kind !== 'lazy') {
      // The search opened the tree; collapsing one row would be arguing with it.
      return;
    }
    const paths = row.chain.length > 0 ? row.chain : [node.path];
    this.expanded.update((expanded) => {
      const next = new Set(expanded);
      for (const path of paths) {
        if (row.open) {
          next.delete(path);
        } else {
          next.add(path);
        }
      }
      return next;
    });
  }

  /**
   * Toggle one framework kind.
   *
   * Turning it **on** narrows the tree and seeds the expansion at a framework-sensible depth — the
   * browsing half of the expansion distinction. The seed is written into the expansion set rather
   * than applied as an override, so it survives the toggle being turned off again: by then the user
   * has been looking at that directory, and snapping it shut would take their place away.
   */
  protected toggleFramework(frameworkId: string): void {
    const active = new Set(this.activeFrameworks());
    if (active.has(frameworkId)) {
      active.delete(frameworkId);
      this.activeFrameworks.set(active);
      return;
    }
    active.add(frameworkId);
    this.activeFrameworks.set(active);

    const tree = this.tree();
    const seeded = new Set(this.expanded());
    for (const membership of this.held()?.frameworks ?? []) {
      if (membership.frameworkId !== frameworkId) {
        continue;
      }
      const members = new Set(membership.memberPaths);
      for (const path of frameworkSeed(tree, membership.root, members)) {
        seeded.add(path);
      }
    }
    this.expanded.set(seeded);
  }

  toggleIgnore(name: string): void {
    this.activeIgnores.update((active) => {
      const next = new Set(active);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  protected onRules(rules: readonly FilterRule[]): void {
    this.rules.set(rules);
  }

  protected togglePicking(): void {
    this.picking.update((armed) => !armed);
  }

  /** A range was picked. It becomes a code reference, which is what the prompt draft carries. */
  protected onPick(range: PickedRange): void {
    const path = this.selectedPath();
    if (!path) {
      return;
    }
    this.picked.addReference({
      path,
      startLine: range.startLine,
      endLine: range.endLine,
      excerpt: range.excerpt,
    });
  }

  /** Jump the anchor to one picked range — the chip is a link back to what it stands for. */
  protected showReference(reference: CodeReference): void {
    this.nav.openAt(reference.path, {
      startLine: reference.startLine,
      endLine: reference.endLine,
    });
  }

  protected rangeOf(reference: CodeReference): string {
    return formatRange(reference);
  }

  /** Re-read the tree on demand. The retry beside a failure, and nothing else calls it. */
  protected reload(): void {
    void this.load(this.workspaceRowId());
  }

  // ---- reads ---------------------------------------------------------------------------------

  private decideRead(workspaceRowId: number, hint: number, visible: boolean): void {
    if (workspaceRowId <= 0) {
      return;
    }
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    // Once per workspace, not once per effect run: these are fresh objects, so re-setting them while
    // the panel sat hidden would invalidate every downstream computed for nothing.
    if (this.resetFor !== workspaceRowId) {
      this.resetFor = workspaceRowId;
      this.opened.set(new Map());
      this.expanded.set(new Set());
      this.held.set(null);
      this.incoming.set(null);
      this.ignoreText.set(new Map());
      this.readingIgnores.clear();
    }
    if (!visible) {
      return;
    }
    if (this.loadedFor === workspaceRowId && !this.missedHint) {
      return;
    }
    this.missedHint = false;
    this.loadedFor = workspaceRowId;
    void this.load(workspaceRowId);
  }

  /**
   * The two reads, issued together.
   *
   * The detection failure is swallowed and the tree's is not: a tree with no framework footer is a
   * working file browser, and a second error line for a feature the user did not ask for would bury
   * the one that matters.
   */
  private async load(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    const detecting = this.filesApi
      .detection(workspaceRowId)
      .then((detection) => {
        this.incoming.set(detection);
        // Handed on so the Agents tab's plugin recommender never fetches this surface a second
        // time. One entry, one read — the panel that owns the generation gate keeps owning it.
        this.shared.publish(workspaceRowId, detection);
      })
      .catch(() => undefined);

    this.listing.set(LOADING);
    try {
      const listing = await this.filesApi.files(workspaceRowId);
      // The per-directory cache describes one generation. While the token holds, re-expanding an
      // opened directory stays free; when it moves, every cached level may be stale and is dropped —
      // and so are the ignore files, whose text is a fact about the same tree.
      if (this.generationOnHand() !== listing.generation) {
        this.opened.set(new Map());
        this.ignoreText.set(new Map());
        this.readingIgnores.clear();
      }
      this.listing.set(ready(listing));
    } catch (error) {
      this.listing.set(failed(error));
    }
    await detecting;
  }

  private generationOnHand(): string {
    const state = untracked(this.listing);
    return state.kind === 'ready' ? state.value.generation : '';
  }

  private async openLazyDir(path: string): Promise<void> {
    const workspaceRowId = this.workspaceRowId();
    this.pending.update((pending) => new Set(pending).add(path));
    try {
      const listing = await this.filesApi.files(workspaceRowId, path);
      this.opened.update((opened) => new Map(opened).set(path, listing));
      this.expanded.update((expanded) => new Set(expanded).add(path));
    } catch {
      // Silent, as the spec's interaction table says: a folder that will not open stays shut, and
      // the daemon being gone is already said once in the status strip.
    } finally {
      this.pending.update((pending) => {
        const next = new Set(pending);
        next.delete(path);
        return next;
      });
    }
  }

  /**
   * Read the ignore files an active list needs, once each.
   *
   * A file that fails to read contributes nothing and is not retried: the filter is an aid, and a
   * missing `.gitignore` in one subdirectory should cost that directory's rules rather than the
   * whole feature. The in-flight set is what stops the effect re-issuing a read that has not
   * answered yet.
   */
  private readIgnoreFiles(
    workspaceRowId: number,
    active: ReadonlySet<string>,
    paths: readonly string[],
  ): void {
    if (workspaceRowId <= 0) {
      return;
    }
    for (const name of active) {
      for (const source of ignoreSources(paths, name)) {
        if (this.ignoreText().has(source.path) || this.readingIgnores.has(source.path)) {
          continue;
        }
        this.readingIgnores.add(source.path);
        void this.filesApi
          .content(workspaceRowId, source.path)
          .then((answer) => {
            if (!answer.binary && answer.content !== undefined) {
              this.ignoreText.update((text) => new Map(text).set(source.path, answer.content!));
            }
          })
          .catch(() => undefined)
          .finally(() => this.readingIgnores.delete(source.path));
      }
    }
  }

  /**
   * The closest-match entry point.
   *
   * It waits for the tree, because a match cannot be found in a listing that has not arrived. Once
   * it has one it seeds the box and clears the parameter — with `replaceUrl`, because the guess was
   * never a place worth going back to.
   */
  private resolveNear(near: string | null, paths: readonly string[]): void {
    if (!near || near === this.consumedNear || paths.length === 0) {
      return;
    }
    this.consumedNear = near;
    this.query.set(near);
    const match = closestMatch(
      paths.filter((path) => this.matched()?.has(path) ?? true),
      near,
    );
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { near: null, path: match ?? null, lines: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
