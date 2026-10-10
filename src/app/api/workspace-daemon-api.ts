import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal, type Signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';

/** What the last call through the proxy said about the workspace's daemon. */
export type DaemonReachability = 'unknown' | 'reachable' | 'unreachable';

/**
 * The statuses that mean "the daemon is not there", as opposed to "the daemon answered no".
 *
 * 0 is a request that never got an answer. 502 and 504 are the proxy's own words: it looked the
 * workspace's daemon up, found nothing listening, and said so. A 404 from the same path is *not*
 * here — that is the daemon answering that a file does not exist, which is a working daemon.
 */
const UNREACHABLE_STATUSES: readonly number[] = [0, 502, 503, 504];

/**
 * The browser's way in to one workspace's in-container daemon, and the only one there is.
 *
 * **The proxy carries everything the daemon owns; the host serves only what the host owns; nothing
 * forwards.** `/workspaces/container/{id}/*` is a verbatim byte proxy in qits-workspaces: it rewrites
 * no path, sets `Authorization` to the daemon's own token (replacing whatever arrived, so the browser
 * never holds a daemon credential and cannot smuggle one in), and passes websocket upgrades through.
 * The SPA is served by qits-workspaces at `/workspaces/`, so the proxy is same-origin with the page
 * and the gateway session cookie rides along with no CORS and no machine token.
 *
 * The alternative — thin typed host routes forwarding to the daemon — is a second copy of a contract
 * that has to be kept in step forever, for roughly forty endpoints, and it would not even remove the
 * proxy, because the two websockets must ride it regardless. Two mechanisms and two auth stories for
 * one daemon.
 *
 * **This class is the transport and deliberately not the API.** The typed clients — files, content,
 * agent worktrees, detection, commands, harnesses, plugins, prompt refinement — are
 * written against the daemon's own contract by the workstreams that need them, each one calling
 * {@link get} or {@link post}. Putting them all here would make one file that every later change
 * touches, and none of them can be written honestly before the panel that reads them exists.
 *
 * **It watches for the daemon going away, because that is now a page-wide event.** The reverse tunnel
 * made the daemon's control socket load-bearing for the proxy: the route resolves through the tunnel
 * registry first, and that registry empties the instant the socket closes. So a daemon reconnect blip
 * takes the file browser, every terminal and the whole agent surface down at once — and the only
 * symptom, without this, is a wall of identical 502s in seven panels. {@link reachability} is what
 * lets the status strip say "half of this page cannot work right now" in one sentence instead.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceDaemonApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);
  private readonly document = inject(DOCUMENT);

  private readonly reach = signal<DaemonReachability>('unknown');

  /**
   * What the proxy last said. `unknown` until something is asked — an untried daemon is not a broken
   * one, and drawing "unreachable" before the first request would be the strip's one outright lie.
   */
  readonly reachability: Signal<DaemonReachability> = this.reach.asReadonly();

  /** Forget what was observed. The shell calls this when the workspace under it changes. */
  resetReachability(): void {
    this.reach.set('unknown');
  }

  /**
   * The proxy prefix for one workspace. Every path below is appended to it verbatim, because the
   * proxy strips nothing: `/files` on the daemon is `/workspaces/container/7/files` from here.
   */
  containerBase(workspaceRowId: number): string {
    return `${this.base}/workspaces/container/${encodeURIComponent(workspaceRowId)}`;
  }

  /** A read against the daemon. `path` starts with a slash and is the daemon's own. */
  async get<T>(
    workspaceRowId: number,
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    return this.observe(
      firstValueFrom(
        this.http.get<T>(`${this.containerBase(workspaceRowId)}${path}`, {
          params: toParams(params),
        }),
      ),
    );
  }

  /** A write against the daemon. */
  async post<T>(workspaceRowId: number, path: string, body: unknown = {}): Promise<T> {
    return this.observe(
      firstValueFrom(this.http.post<T>(`${this.containerBase(workspaceRowId)}${path}`, body)),
    );
  }

  /**
   * The absolute `ws://` (or `wss://`) URL for one of the daemon's two sockets — the interactive
   * terminal and the agent chat.
   *
   * It is absolute because `WebSocket` takes no relative URL, and the scheme is derived from the
   * page's rather than configured: the SPA is same-origin with the proxy by construction, so any
   * other answer would be describing a deployment that does not exist. The bearer is set by the
   * proxy on the inbound request rather than by an interceptor, because `vertx-http-proxy` skips its
   * interceptor chain on an upgrade — without that fix every socket here was a 401.
   */
  socketUrl(workspaceRowId: number, path: string): string {
    const page = this.document.defaultView?.location;
    const scheme = page?.protocol === 'https:' ? 'wss:' : 'ws:';
    const origin = page ? `${scheme}//${page.host}` : '';
    return `${origin}${this.containerBase(workspaceRowId)}${path}`;
  }

  /**
   * Record what one call implies about the daemon, then hand the result on unchanged.
   *
   * Any answer at all means the daemon is there — including its own 4xx. Only the statuses that mean
   * "nothing answered" flip it the other way, so a missing file does not report the container as
   * gone.
   */
  private async observe<T>(call: Promise<T>): Promise<T> {
    try {
      const value = await call;
      this.reach.set('reachable');
      return value;
    } catch (error) {
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      this.reach.set(UNREACHABLE_STATUSES.includes(status) ? 'unreachable' : 'reachable');
      throw error;
    }
  }
}

function toParams(params: Record<string, string | number> | undefined): HttpParams | undefined {
  if (!params) {
    return undefined;
  }
  let built = new HttpParams();
  for (const [key, value] of Object.entries(params)) {
    built = built.set(key, value);
  }
  return built;
}
