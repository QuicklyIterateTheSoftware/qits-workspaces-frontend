import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { TerminalFrames } from './terminal-socket';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** A real xterm.js terminal over the daemon's raw PTY frame stream. */
@Component({
  selector: 'app-terminal-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #host class="terminal-host" [attr.aria-label]="label()">
      @if (!ready()) {
        <pre class="loading-screen" role="log">{{ pendingText() }}</pre>
      }
    </div>
    <p class="hint">{{ hint() }}</p>
  `,
  styles: `
    :host {
      display: block;
    }
    .terminal-host {
      box-sizing: border-box;
      /* Only until relayout() has measured the room below the fold; these two bounds clamp what it
         measures. The floor keeps a cramped viewport usable. The ceiling deliberately sits just
         under the viewport: a tall page is meant to be nearly all terminal, and the clamp is left
         in only to catch a pane that reports something absurd. The initial height is a guess at
         the room, on screen until the lazy xterm chunk lands and relayout() runs, so it tracks the
         viewport too rather than jumping a screen's worth when the measurement arrives. */
      height: min(40rem, 70vh);
      min-height: 12rem;
      max-height: 95vh;
      overflow: hidden;
      /* Horizontal only: the fit addon sizes rows against the host's client height, which includes
         vertical padding, so any y padding pushes the bottom row past the box. */
      padding: 0 0.5rem;
      border: 1px solid #1f2937;
      border-radius: 0.375rem;
      background: #111827;
    }
    .terminal-host:focus-within {
      outline: 2px solid #93c5fd;
      outline-offset: -2px;
    }
    .loading-screen {
      margin: 0;
      color: #e5e7eb;
      font: 0.8rem/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
    }
    .hint {
      margin: 0.35rem 0 0;
      color: #6b7280;
      font-size: 0.8rem;
    }
  `,
})
export class TerminalView {
  readonly frames = input.required<TerminalFrames>();
  readonly label = input('Agent session');
  readonly attached = input(false);
  readonly data = output<string>();
  readonly resized = output<TerminalSize>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly ready = signal(false);
  protected readonly pendingText = computed(() => this.frames().chunks.join(''));
  protected readonly hint = computed(() =>
    this.attached()
      ? 'Click the terminal and type; paste with Ctrl+V. Input goes straight to the agent.'
      : 'Not attached — this is the last frame the session painted.',
  );

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private observer: ResizeObserver | null = null;
  private disposables: IDisposable[] = [];
  private generation = -1;
  private written = 0;
  private destroyed = false;

  constructor() {
    afterNextRender(() => void this.mount());

    effect(() => {
      const frames = this.frames();
      if (!this.ready() || !this.terminal) return;
      if (frames.generation !== this.generation) {
        this.terminal.reset();
        this.generation = frames.generation;
        this.written = 0;
      }
      for (const chunk of frames.chunks.slice(this.written)) this.terminal.write(chunk);
      this.written = frames.chunks.length;
    });

    effect(() => {
      const attached = this.attached();
      if (this.ready() && this.terminal) this.terminal.options.disableStdin = !attached;
    });

    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  private async mount(): Promise<void> {
    // xterm.js requires matchMedia for DPR tracking. Keeping the raw-frame fallback visible makes
    // server-side and DOM-only test renderers useful without pretending they can emulate a terminal.
    if (!this.host().nativeElement.ownerDocument.defaultView?.matchMedia) return;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    if (this.destroyed) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: !this.attached(),
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      screenReaderMode: true,
      scrollback: 6000,
      theme: { background: '#111827', foreground: '#e5e7eb' },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(this.host().nativeElement);
    terminal.textarea?.setAttribute('aria-label', `${this.label()} input`);
    this.disposables = [
      terminal.onData((value) => {
        if (this.attached()) this.data.emit(value);
      }),
      terminal.onResize(({ cols, rows }) => this.resized.emit({ cols, rows })),
    ];
    this.terminal = terminal;
    this.fitAddon = fitAddon;

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        this.relayout();
        this.fit();
      });
      this.observer.observe(this.host().nativeElement);
    }
    // Growing the pane does not resize a host whose height is a measured pixel value, so the
    // observer above never hears about it; the window does.
    const view = this.host().nativeElement.ownerDocument.defaultView;
    if (view) {
      const onViewportResize = () => this.relayout();
      view.addEventListener('resize', onViewportResize);
      this.disposables.push({
        dispose: () => view.removeEventListener('resize', onViewportResize),
      });
    }
    this.relayout();
    this.fit();
    this.ready.set(true);
    terminal.focus();
  }

  /**
   * Size the host to the room between its top edge and the foot of the scrolling pane, so the
   * bottom of the terminal — the row the prompt sits on — ends above the fold instead of just past
   * it. The stylesheet's `height` only ever guesses at that room — it loses by a line on shorter
   * viewports and leaves a band of empty pane on taller ones, because what stands above the
   * terminal is the page's business, not the viewport's. The stylesheet's min/max clamp the
   * answer; only the measured middle is supplied here.
   */
  private relayout(): void {
    const host = this.host().nativeElement;
    const view = host.ownerDocument.defaultView;
    // A hidden tab has no geometry to measure. Its ResizeObserver retries when visible.
    if (!view || host.getClientRects().length === 0) return;
    const pane = scrollPane(host);
    // The host's offset from the top of the pane's *content*, scroll factored out, so the height
    // is the same wherever the reader happens to have scrolled when this runs. The document is its
    // own coordinate origin; an inner pane's border box stands still while its content moves.
    const paneTop =
      pane === host.ownerDocument.documentElement ? 0 : pane.getBoundingClientRect().top;
    const top = host.getBoundingClientRect().top - paneTop + pane.scrollTop;
    // Whatever the component draws under the host — the hint — keeps its place below the terminal.
    const below =
      this.root.nativeElement.getBoundingClientRect().bottom - host.getBoundingClientRect().bottom;
    const foot = parseFloat(view.getComputedStyle(pane).paddingBottom) || 0;
    host.style.height = `${Math.max(0, Math.floor(pane.clientHeight - top - below - foot))}px`;
  }

  private fit(): void {
    try {
      this.fitAddon?.fit();
    } catch {
      // A hidden tab has no measurable cell geometry. Its ResizeObserver retries when visible.
    }
  }

  private destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }
}

/** The ancestor that scrolls this element: the chrome's content pane, or — on a bare `ng serve`
 *  with no chrome around the page — the document itself. */
function scrollPane(el: HTMLElement): HTMLElement {
  const view = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node && view; node = node.parentElement) {
    const { overflowY } = view.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return el.ownerDocument.documentElement;
}
