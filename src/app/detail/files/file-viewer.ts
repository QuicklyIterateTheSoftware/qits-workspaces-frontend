import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { FileContentDto } from '../../api/files-api';
import { FILE_CONTENT_CAP_BYTES, FilesApi } from '../../api/files-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';

/** A range of lines, one-based and inclusive at both ends — the way a file's own line numbers read. */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** A range that has just been picked, with the text it stood for captured at pick time. */
export interface PickedRange extends LineRange {
  readonly excerpt: string;
}

/** One drawn line. The number is what the gutter prints and what a range is expressed in. */
interface ViewerLine {
  readonly number: number;
  readonly text: string;
}

/**
 * The read-only file viewer: line numbers, a painted highlight, and line picking.
 *
 * ## What it loads
 *
 * **Opening a file costs exactly one request** — `GET /files/content?path=…` — and everything else it
 * draws is already in hand: the test/code strip comes from the detection the tree fetched, and the
 * highlights come from the picks the page already holds. One more read happens each time a `files`
 * hint lands **while this tab is showing**, because the file you are staring at while an agent edits
 * it is the one place stale content is actively misleading. Hidden, it records the hint and spends it
 * as one catch-up read when the tab comes back, exactly as the tree does.
 *
 * The content is **not cached per path**. A file browser over a tree an agent is rewriting has no
 * business showing yesterday's bytes, and re-reading is one request against a daemon in the same
 * container.
 *
 * ## The binary flag says two things
 *
 * `binary: true` is returned both for a genuinely binary file and for one over the daemon's 2 MB cap,
 * because the cap soft-degrades to that shape instead of answering 413. Nothing on the platform
 * publishes a file's size, so **the page cannot tell them apart and does not pretend to**: the copy
 * reads "too large or binary" and says why. {@link knownBytes} is the seam for the day a size is
 * knowable — set it and the copy becomes specific. Guessing from the extension would be a claim
 * nobody checked, dressed as a fact.
 *
 * ## Named, not built
 *
 * **Syntax highlighting** and the **rendered-markdown view** are the two fast-follows this component
 * is shaped for. Both are `@defer (on viewport)` blocks around this same pane — a highlighter is
 * roughly the size of the rest of the application and a markdown renderer is not much smaller, and
 * neither is worth a byte on a page whose Files tab may never be opened. The load-bearing 90% is a
 * monospace pane with line numbers, ranges and a highlight overlay, and that is what is here.
 * **Row virtualisation** is the third: every line is a DOM row today, which is fine for the files
 * people read and slow for a 2 MB one.
 */
@Component({
  selector: 'app-file-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty],
  template: `
    @if (!path()) {
      <app-empty message="Select a file to view its contents." />
    } @else {
      <app-async
        [state]="file()"
        [loadingLabel]="'Loading ' + path()"
        [errorLabel]="'Failed to load ' + path()"
        (retry)="reload()"
      />

      @if (file(); as state) {
        @if (state.kind === 'ready') {
          @if (state.value.binary) {
            <p class="unrenderable" role="status">{{ unrenderable() }}</p>
          } @else if (lines().length === 0) {
            <p class="unrenderable" role="status">This file is empty.</p>
          } @else {
            <div class="code" [class.picking]="picking()">
              <ol class="lines">
                @for (line of lines(); track line.number) {
                  <li
                    class="line"
                    [class.anchored]="isAnchored(line.number)"
                    [class.picked]="isPicked(line.number)"
                    [class.pending]="line.number === pendingFrom()"
                    [attr.data-line]="line.number"
                  >
                    @if (picking()) {
                      <button
                        type="button"
                        class="num"
                        [attr.aria-label]="'Pick from line ' + line.number"
                        (click)="onGutter(line.number, $event)"
                      >
                        {{ line.number }}
                      </button>
                    } @else {
                      <span class="num" aria-hidden="true">{{ line.number }}</span>
                    }
                    <code class="text">{{ line.text }}</code>
                  </li>
                }
              </ol>
            </div>
          }
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .unrenderable {
      margin: 0.5rem 0;
      color: #6b7280;
      font-size: 0.85rem;
    }
    .code {
      overflow: auto;
      max-height: 34rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.35rem;
      background: #ffffff;
    }
    .lines {
      margin: 0;
      padding: 0.35rem 0;
      list-style: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.8rem;
      line-height: 1.5;
    }
    .line {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      padding: 0 0.5rem;
    }
    .line.picked {
      background: #eff6ff;
    }
    .line.anchored {
      background: #fef3c7;
    }
    .line.pending {
      outline: 1px dashed #2563eb;
      outline-offset: -1px;
    }
    .num {
      flex: 0 0 3rem;
      padding: 0;
      border: 0;
      background: none;
      color: #9ca3af;
      font: inherit;
      text-align: right;
      user-select: none;
    }
    .code.picking .num {
      color: #2563eb;
      cursor: pointer;
    }
    .code.picking .num:hover {
      text-decoration: underline;
    }
    .text {
      flex: 1 1 auto;
      color: #111827;
      white-space: pre;
      tab-size: 2;
    }
  `,
})
export class FileViewer {
  private readonly filesApi = inject(FilesApi);
  private readonly events = inject(WorkspaceEvents);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly workspaceRowId = input.required<number>();

  /** Whose worktree the path is relative to. */
  readonly agentId = input.required<string>();

  /** The open file, or null for the empty state. */
  readonly path = input<string | null>(null);

  /** Whether the Files tab is the one showing. Hidden, this reads nothing. */
  readonly visible = input(false);

  /** Whether pick mode is armed. Sticky across picks, and the panel disarms it on a file change. */
  readonly picking = input(false);

  /** The deep link's range: painted and scrolled to, distinct from a pick. */
  readonly anchor = input<LineRange | null>(null);

  /** The ranges already picked **in this file**, painted persistently. */
  readonly picks = input<readonly LineRange[]>([]);

  /**
   * The file's size, when something knows it.
   *
   * Nothing does today — neither `/files` nor `/files/content` publishes one — so this stays unset
   * and the copy stays honest. It exists because the contract's own advice is "distinguish them when
   * the size is knowable", and the seam is the cheap half of taking that advice.
   */
  readonly knownBytes = input<number | null>(null);

  /** A range was picked. The panel turns it into a code reference. */
  readonly pick = output<PickedRange>();

  protected readonly file = signal<Loadable<FileContentDto>>(IDLE);

  /** The first end of a range in progress. Null means the next click starts one. */
  protected readonly pendingFrom = signal<number | null>(null);

  private readonly hints = this.events.invalidations('files');
  private loadedKey: string | null = null;
  private seenHint = -1;
  private missedHint = false;

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const path = this.path();
      const hint = this.hints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, path, hint, visible));
    });

    // Disarming a half-made range when the file changes: the other end was a line number in a file
    // nobody is looking at any more, and committing it later would pick a range at random.
    effect(() => {
      this.path();
      untracked(() => this.pendingFrom.set(null));
    });

    // Scroll to the anchor once the content that has the line in it is on screen. It runs on the
    // content rather than on the anchor because an anchor that arrives before the file has nothing
    // to scroll to, and both orders happen.
    effect(() => {
      const state = this.file();
      const anchor = this.anchor();
      if (state.kind === 'ready' && anchor) {
        untracked(() => queueMicrotask(() => this.scrollTo(anchor.startLine)));
      }
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  /**
   * The lines to draw.
   *
   * A single trailing empty entry is dropped: a file that ends with a newline splits into one more
   * piece than it has lines, and a phantom final row would put a line number on nothing and let a
   * pick run one past the end.
   */
  protected readonly lines = computed<readonly ViewerLine[]>(() => {
    const state = this.file();
    if (state.kind !== 'ready' || state.value.binary || state.value.content === undefined) {
      return [];
    }
    if (state.value.content === '') {
      return [];
    }
    const pieces = state.value.content.split('\n');
    if (pieces.length > 1 && pieces[pieces.length - 1] === '') {
      pieces.pop();
    }
    return pieces.map((text, at) => ({ number: at + 1, text }));
  });

  /**
   * What to say when the daemon sent the flag instead of the bytes.
   *
   * The two cases are indistinguishable from the body, so the sentence names both and says why —
   * "this file is binary" would be a guess presented as a finding, and the user reading it about a
   * 3 MB log would conclude the page is broken.
   */
  protected readonly unrenderable = computed(() => {
    const bytes = this.knownBytes();
    if (bytes !== null) {
      return bytes > FILE_CONTENT_CAP_BYTES
        ? `This file is ${Math.round(bytes / 1024 / 1024)} MB, over the 2 MB read limit, so it was not sent.`
        : 'This file is binary, so there is nothing to show.';
    }
    return 'This file is too large or binary — the workspace sends both the same way, so this page cannot tell which. The read limit is 2 MB.';
  });

  protected isAnchored(line: number): boolean {
    const anchor = this.anchor();
    return anchor !== null && line >= anchor.startLine && line <= anchor.endLine;
  }

  protected isPicked(line: number): boolean {
    return this.picks().some((range) => line >= range.startLine && line <= range.endLine);
  }

  // ---- picking -------------------------------------------------------------------------------

  /**
   * A gutter number was pressed while pick mode was armed.
   *
   * Two clicks make a range and one shift-click makes one from wherever the first end already was,
   * which is the gesture every code host uses. A single line is a legal range and picks itself, so
   * "line 12" costs two clicks on 12 rather than a second gesture nobody would find.
   */
  protected onGutter(line: number, event: MouseEvent): void {
    const from = this.pendingFrom();
    if (from === null && !event.shiftKey) {
      this.pendingFrom.set(line);
      return;
    }
    const start = Math.min(from ?? line, line);
    const end = Math.max(from ?? line, line);
    this.pendingFrom.set(null);
    this.pick.emit({ startLine: start, endLine: end, excerpt: this.excerptOf(start, end) });
  }

  /**
   * The text a pick stood for, captured now.
   *
   * The excerpt is a snapshot on purpose: it is what the chip previews and what the prompt carries,
   * and a reference whose text silently followed later edits would describe something the user never
   * chose.
   */
  private excerptOf(start: number, end: number): string {
    return this.lines()
      .slice(start - 1, end)
      .map((line) => line.text)
      .join('\n');
  }

  // ---- reads ---------------------------------------------------------------------------------

  protected reload(): void {
    const path = this.path();
    if (path) {
      void this.load(this.workspaceRowId(), path);
    }
  }

  private decideRead(
    workspaceRowId: number,
    path: string | null,
    hint: number,
    visible: boolean,
  ): void {
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    if (workspaceRowId <= 0 || !path) {
      this.file.set(IDLE);
      this.loadedKey = null;
      return;
    }
    if (!visible) {
      return;
    }
    const key = `${workspaceRowId}:${path}`;
    if (this.loadedKey === key && !this.missedHint) {
      return;
    }
    this.missedHint = false;
    this.loadedKey = key;
    void this.load(workspaceRowId, path);
  }

  private async load(workspaceRowId: number, path: string): Promise<void> {
    this.file.set(LOADING);
    try {
      const content = await this.filesApi.content(workspaceRowId, this.agentId(), path);
      // A late answer for a file nobody is reading any more is dropped rather than drawn: two opens
      // in quick succession must not leave the first one's bytes under the second one's name.
      if (this.path() === path) {
        this.file.set(ready(content));
      }
    } catch (error) {
      if (this.path() === path) {
        this.file.set(failed(error));
      }
    }
  }

  private scrollTo(line: number): void {
    const element = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
      `.line[data-line="${line}"]`,
    );
    // Guarded because jsdom has no layout and does not implement it, and a viewer that throws in a
    // spec would be a test failure about scrolling rather than about the file.
    element?.scrollIntoView?.({ block: 'center' });
  }
}
