import { signal, type Signal } from '@angular/core';
import { WEB_SOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from '../../api/web-socket';

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

/** Raw PTY frames since the latest attachment. xterm.js, not the socket, interprets them. */
export interface TerminalFrames {
  readonly generation: number;
  readonly chunks: readonly string[];
}

export const EMPTY_TERMINAL_FRAMES: TerminalFrames = { generation: 0, chunks: [] };

/** The backoff ladder, capped where the contract caps it. Five attempts, then the budget is spent. */
export const TERMINAL_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 4000];

/** Whether the PTY is attached, coming back, or finished. */
export type TerminalLink = 'connecting' | 'open' | 'reconnecting' | 'disconnected' | 'lost';

/**
 * A close code of 1000 from the server. **Final, and the client may not fake it** — which is why
 * `WebSocketLike.close()` takes no code.
 */
const CLEAN_CLOSE = 1000;

/**
 * One attachment to `WS /terminal/commands/{id}`.
 *
 * Every rule here was learned from a real failure, and the contract states each one:
 *
 * **Opening re-attaches and replays 256 KB of scrollback; closing only detaches.** The process
 * survives a browser refresh, a tab switch and this object being thrown away — to actually stop
 * something you call `POST /commands/{id}/terminate`, which is a different verb in a different
 * client on purpose.
 *
 * **A clean server close (1000) is final.** It means the command is gone: print `[disconnected]` and
 * stop. Reconnecting into it would produce the daemon's yellow *"This command is no longer running"*
 * line on a loop.
 *
 * **Everything else reconnects with a capped backoff, and each attempt resets the screen.** The
 * replay repaints it — that is what the replay is for — so clearing first is how a reconnect avoids
 * stitching half of the old frame to all of the new one.
 *
 * **A spent budget re-arms on `visibilitychange` and on `online`.** A laptop sleep outlives an
 * eight-second window, and "I'm back" is an event rather than something to poll for. Without this
 * the terminal is dead on wake and the only cure is a page reload.
 *
 * **Key it by command id.** A relaunch is a new command and must be a new socket; reusing one bound
 * to a dead process is how a terminal ends up permanently showing someone else's exit.
 */
export class TerminalSocket {
  private readonly received = signal<TerminalFrames>(EMPTY_TERMINAL_FRAMES);
  private readonly link = signal<TerminalLink>('connecting');

  /** Raw frames for xterm.js. A new generation means clear before replaying its chunks. */
  readonly frames: Signal<TerminalFrames> = this.received.asReadonly();

  /** Where the attachment is. `lost` is "the retries are spent", which offers a manual way back. */
  readonly status: Signal<TerminalLink> = this.link.asReadonly();

  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;

  private readonly wake = () => this.rearm();

  constructor(
    private readonly url: string,
    private readonly open: WebSocketFactory,
    private readonly document: Document,
  ) {}

  /** Attach, and keep re-attaching until {@link close} or a clean server close. */
  connect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.document.addEventListener('visibilitychange', this.wake);
    this.document.defaultView?.addEventListener('online', this.wake);
    this.attach();
  }

  /**
   * Detach for good.
   *
   * The process keeps running; this is called when the panel is destroyed or the command changes,
   * never when the tab is merely hidden — the Terminal tab is one of the surfaces that keep
   * working out of sight.
   */
  close(): void {
    this.stopped = true;
    this.clearTimer();
    this.document.removeEventListener('visibilitychange', this.wake);
    this.document.defaultView?.removeEventListener('online', this.wake);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.link.set('disconnected');
  }

  /** Keystrokes, written to the PTY. Dropped while detached: a terminal has no send queue. */
  send(data: string): void {
    const socket = this.socket;
    if (socket && socket.readyState === WEB_SOCKET_OPEN) {
      socket.send(JSON.stringify({ type: 'data', data }));
    }
  }

  /** Tell the PTY how big it is. A missing dimension falls back to 80x24 on the daemon's side. */
  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    const socket = this.socket;
    if (socket && socket.readyState === WEB_SOCKET_OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: this.cols, rows: this.rows }));
    }
  }

  /** Try again now — the button beside a spent budget, and what a wake event calls. */
  rearm(): void {
    if (this.stopped || this.link() !== 'lost') {
      return;
    }
    this.attempt = 0;
    this.attach();
  }

  private attach(): void {
    this.clearTimer();
    this.socket?.close();
    // The replay is about to repaint everything, so whatever the last attachment left is stale.
    this.received.update(({ generation }) => ({ generation: generation + 1, chunks: [] }));
    this.link.set(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = this.open(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.link.set('open');
      socket.send(JSON.stringify({ type: 'resize', cols: this.cols, rows: this.rows }));
    };
    socket.onmessage = (event) => {
      this.received.update((current) => ({
        ...current,
        chunks: [...current.chunks, event.data],
      }));
    };
    socket.onclose = (event) => this.handleClose(event);
    socket.onerror = () => {
      // A socket error is always followed by a close, and the close is where the retry lives.
    };
  }

  private handleClose(event: CloseEvent): void {
    this.socket = null;
    if (this.stopped) {
      this.link.set('disconnected');
      return;
    }
    if (event?.code === CLEAN_CLOSE) {
      // The command is gone. The daemon has already written its yellow line into the screen above.
      this.link.set('disconnected');
      return;
    }
    const wait = TERMINAL_BACKOFF_MS[this.attempt];
    if (wait === undefined) {
      this.link.set('lost');
      return;
    }
    this.attempt += 1;
    this.link.set('reconnecting');
    this.timer = setTimeout(() => this.attach(), wait);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
