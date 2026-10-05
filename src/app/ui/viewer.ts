import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { statusOf } from './loadable';

/**
 * Whether the page should assume, before anything says otherwise, that its viewer holds
 * `qits:admin`.
 *
 * **True by default, because nothing in the browser can say otherwise yet.** No service this app
 * talks to answers the viewer's roles: the edge turns the session into `X-Qits-Roles` on the way
 * in and the browser never sees it. Every read this app makes already takes `qits:admin` or
 * `qits:agent`, so a person who has the page in front of them at all is, today, an admin. A token
 * rather than a constant so a spec can be the viewer who is not, and so a real roles read has one
 * place to land.
 */
export const VIEWER_ADMIN = new InjectionToken<boolean>('qits.viewer-admin', {
  providedIn: 'root',
  factory: () => true,
});

/**
 * What this page knows about who is looking at it: one fact, whether they may press admin-only
 * doors.
 *
 * It starts from {@link VIEWER_ADMIN} and learns from the service: an admin door that answers 403
 * is the authority saying no, so {@link noteRefusal} demotes the viewer for the rest of the session
 * and the controls the service refuses stop being offered. The server remains the gate either way —
 * hiding a button is a courtesy, never the protection.
 */
@Injectable({ providedIn: 'root' })
export class Viewer {
  private readonly assumed = inject(VIEWER_ADMIN);
  private readonly refused = signal(false);

  readonly admin = computed(() => this.assumed && !this.refused());

  /** Read a failed admin-door call; a 403 means this viewer is not an admin. */
  noteRefusal(error: unknown): void {
    if (statusOf(error) === 403) {
      this.refused.set(true);
    }
  }
}
