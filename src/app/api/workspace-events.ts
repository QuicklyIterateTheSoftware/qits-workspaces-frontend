import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { QITS_API_BASE } from './api-base';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './event-source';

/**
 * Every topic one workspace's live channel emits, copied from `WorkspaceChangeHint.Topic` with the
 * service's own naming rule applied: the enum constant lowercased, underscores to hyphens.
 *
 * The list is complete rather than trimmed to what is drawn today. Five of these currently fire
 * against readers that do not exist yet — the channel is ahead of the API — and a counter costs a
 * signal, so declaring them all means a panel landing later wires to a topic that is already
 * ticking instead of adding one.
 */
export const WORKSPACE_TOPICS = [
  'telemetry',
  'commands',
  'bootstrap',
  'files',
  'git-status',
  'agent-activity',
  'process',
  'prompt-draft',
  'prompt-attachments',
] as const;

/** One of {@link WORKSPACE_TOPICS}. */
export type WorkspaceTopic = (typeof WORKSPACE_TOPICS)[number];

/**
 * The workspace's live channel: one connection, payload-free hints, and a counter per topic.
 *
 * **Hint-and-refetch, not push-the-data.** Every frame is a topic name and nothing else. A panel
 * reads the counter for the topic it cares about inside an `effect` and re-issues its own ordinary
 * REST request when the number moves. That is what replaced eight independent polls, and it is why
 * an idle workspace produces no traffic at all — polling has a floor and this does not. It also
 * means there is no pushed shape to drift from the fetched one, and no partial-update merge logic
 * anywhere.
 *
 * **Invalidate everything on every connect, and on every reconnect.** {@link handleOpen} bumps all
 * nine counters. There is no replay protocol here, no `Last-Event-ID`, no resume token and no
 * snapshot-then-delta — the server offers none and the client must not invent one. The browser's own
 * reconnect handles the retry; this one burst closes whatever gap the disconnected window left. It
 * costs a handful of requests on reconnect and removes an entire class of correctness bugs, which is
 * the best trade on the screen.
 *
 * **An unrecognised topic is ignored, not an error.** `ping` arrives every ~25 seconds to hold the
 * connection open through intermediate proxies, and a newer service may invent a topic this build
 * has never heard of. Both fall through the same door.
 *
 * **Nothing here polls.** That is a rule and not a tendency: the explorer screens poll because they
 * have no channel, and this page has one.
 *
 * The service is application-scoped but singly-owned: the detail shell opens it for the workspace it
 * is showing and closes it on destroy. {@link connected} is what draws the quiet inline marker that
 * says the page is briefly behind — a stale-data notice, deliberately unlike the daemon's own
 * disconnection, which stops half the page working and gets a first-class state in the status strip.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceEvents {
  private readonly base = inject(QITS_API_BASE);
  private readonly openStream = inject(EVENT_SOURCE_FACTORY);

  private readonly counters = new Map(WORKSPACE_TOPICS.map((topic) => [topic, signal(0)] as const));

  private readonly link = signal(false);

  /** Whether the channel is up. False means the data is stale and will catch up, not that it is wrong. */
  readonly connected: Signal<boolean> = this.link.asReadonly();

  private source: EventSourceLike | null = null;
  private streamed: number | null = null;

  /**
   * How many times this topic has been invalidated. Read it in an `effect`; the value is meaningless
   * and only its movement matters.
   */
  invalidations(topic: WorkspaceTopic): Signal<number> {
    return this.counters.get(topic)!.asReadonly();
  }

  /**
   * Watch one workspace. Calling it again for the same id does nothing, so an effect may call it
   * freely; calling it for a different id moves the connection.
   */
  open(workspaceId: number): void {
    if (this.streamed === workspaceId && this.source) {
      return;
    }
    this.close();
    this.streamed = workspaceId;
    const source = this.openStream(
      `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/events`,
    );
    source.onopen = () => this.handleOpen();
    source.onmessage = (event) => this.handleTopic(event.data);
    source.onerror = () => this.link.set(false);
    this.source = source;
  }

  /** Stop watching. The shell calls this on destroy; nothing else should need to. */
  close(): void {
    this.source?.close();
    this.source = null;
    this.streamed = null;
    this.link.set(false);
  }

  /**
   * Bump every counter, as a connect does.
   *
   * The channel's own opens call it. So does the Starting tab on a process's terminal frame: the
   * operation just changed the container, the working tree and the command list at once, and naming
   * which topics that is would be a list to keep in step with a server this client cannot see.
   */
  invalidateAll(): void {
    for (const counter of this.counters.values()) {
      counter.update((count) => count + 1);
    }
  }

  private handleOpen(): void {
    this.link.set(true);
    this.invalidateAll();
  }

  private handleTopic(data: string): void {
    const counter = this.counters.get(data.trim() as WorkspaceTopic);
    counter?.update((count) => count + 1);
  }
}

/**
 * A counter that moves when any of the given topics fires — the shape most panels actually want,
 * since "the workspace list is stale" is three topics rather than one.
 */
export function anyOf(
  events: WorkspaceEvents,
  ...topics: readonly WorkspaceTopic[]
): Signal<number> {
  const counters = topics.map((topic) => events.invalidations(topic));
  return computed(() => counters.reduce((total, counter) => total + counter(), 0));
}
