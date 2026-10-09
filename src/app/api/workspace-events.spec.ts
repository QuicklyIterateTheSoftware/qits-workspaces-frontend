import { TestBed } from '@angular/core/testing';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './event-source';
import { WORKSPACE_TOPICS, WorkspaceEvents, type WorkspaceTopic } from './workspace-events';

/** A stream whose every lifecycle moment is a method call. */
class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  connect(): void {
    this.onopen?.(new Event('open'));
  }

  emit(topic: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data: topic }));
  }

  drop(): void {
    this.onerror?.(new Event('error'));
  }
}

/**
 * The one live-data rule worth a spec of its own: **on every connect, and every reconnect,
 * invalidate everything.**
 *
 * The server offers no replay protocol, no `Last-Event-ID` and no resume token, and a client that
 * invented one would be guessing about frames it never saw. Re-fetching every topic on open closes
 * whatever gap the disconnected window left, for the price of one burst of requests — and it removes
 * an entire class of bugs in which the page is quietly wrong about something it stopped hearing
 * about.
 *
 * The timers are faked deliberately, and the last assertion is why: **this client must never
 * schedule anything.** The explorer screens poll because they have no channel; a poll added here
 * would put a traffic floor under an idle workspace, which is the exact cost the channel exists to
 * remove. A timer count of zero after an hour of fake time is that rule, checked.
 */
describe('WorkspaceEvents', () => {
  let events: WorkspaceEvents;
  let opened: FakeStream[];

  beforeEach(() => {
    vi.useFakeTimers();
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const stream = new FakeStream(url);
            opened.push(stream);
            return stream;
          },
        },
      ],
    });
    events = TestBed.inject(WorkspaceEvents);
  });

  afterEach(() => {
    events.close();
    vi.useRealTimers();
  });

  const counters = (): number[] =>
    WORKSPACE_TOPICS.map((topic) => events.invalidations(topic as WorkspaceTopic)());

  it('opens one channel for the workspace, at the workspace-scoped path', () => {
    events.open(7);

    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe('/workspaces/api/workspaces/7/events');
  });

  it('bumps every counter on connect', () => {
    events.open(7);
    expect(counters().every((count) => count === 0)).toBe(true);

    opened[0].connect();

    expect(counters()).toEqual(WORKSPACE_TOPICS.map(() => 1));
    expect(events.connected()).toBe(true);
  });

  it('bumps every counter again on every reconnect, because a reconnect is a connect', () => {
    events.open(7);
    opened[0].connect();
    opened[0].drop();

    expect(events.connected()).toBe(false);

    opened[0].connect();

    expect(counters()).toEqual(WORKSPACE_TOPICS.map(() => 2));
  });

  it('maps one topic frame to one invalidation and leaves every other topic alone', () => {
    events.open(7);
    opened[0].emit('files');
    opened[0].emit('files');

    expect(events.invalidations('files')()).toBe(2);
    expect(events.invalidations('commands')()).toBe(0);
  });

  it('ignores the heartbeat and any topic a newer service invents', () => {
    events.open(7);
    opened[0].emit('ping');
    opened[0].emit('something-that-does-not-exist-yet');

    expect(counters().every((count) => count === 0)).toBe(true);
  });

  it('moves the connection when the workspace changes, and not when it does not', () => {
    events.open(7);
    events.open(7);
    expect(opened).toHaveLength(1);

    events.open(8);

    expect(opened).toHaveLength(2);
    expect(opened[0].closed).toBe(true);
    expect(opened[1].url).toBe('/workspaces/api/workspaces/8/events');
  });

  it('schedules nothing — the channel replaces polling rather than joining it', () => {
    events.open(7);
    opened[0].connect();
    opened[0].emit('commands');
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
