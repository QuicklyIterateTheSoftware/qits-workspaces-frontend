import { TestBed } from '@angular/core/testing';
import type { TechnicalProcessFrame } from '../../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { StartingPanel } from './starting-panel';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;

  close(): void {
    this.readyState = 2;
  }

  frame(frame: Partial<TechnicalProcessFrame>): void {
    const full: TechnicalProcessFrame = {
      segment: null,
      kind: 'line',
      seq: 0,
      line: null,
      status: null,
      hint: null,
      hintTarget: null,
      ...frame,
    };
    this.onmessage?.(new MessageEvent<string>('message', { data: JSON.stringify(full) }));
  }
}

/**
 * A runner-placed start waits in a `queued` segment before its container exists. The key is the
 * service's, not a reader's, so the head says what it is waiting for and the badge says it is
 * waiting rather than running.
 */
describe('StartingPanel', () => {
  let stream: FakeStream;

  beforeEach(() => {
    stream = new FakeStream();
    TestBed.configureTestingModule({
      providers: [{ provide: EVENT_SOURCE_FACTORY, useValue: () => stream }],
    });
  });

  const render = async () => {
    const fixture = TestBed.createComponent(StartingPanel);
    fixture.componentRef.setInput('processId', 'p-1');
    await fixture.whenStable();
    return fixture;
  };

  const heads = (fixture: { nativeElement: HTMLElement }) =>
    Array.from(fixture.nativeElement.querySelectorAll('.head')).map((head) => ({
      name: head.querySelector('.name')?.textContent?.trim(),
      badge: head.querySelector('.badge')?.textContent?.trim(),
    }));

  it('reads the queued segment as what it waits for, then hands over to the container', async () => {
    const fixture = await render();

    stream.frame({ kind: 'segment-open', segment: 'queued' });
    stream.frame({ kind: 'line', segment: 'queued', line: 'waiting for a slot on node-a' });
    fixture.detectChanges();

    expect(heads(fixture)).toEqual([{ name: 'waiting for a slot on node-a', badge: 'waiting' }]);

    stream.frame({ kind: 'segment-settled', segment: 'queued', status: 'ok' });
    stream.frame({ kind: 'segment-open', segment: 'container' });
    fixture.detectChanges();

    expect(heads(fixture)).toEqual([
      { name: 'waiting for a slot on node-a', badge: 'ok' },
      { name: 'container', badge: 'running' },
    ]);
  });

  it('says it waits for a runner before the service has said which', async () => {
    const fixture = await render();

    stream.frame({ kind: 'segment-open', segment: 'queued' });
    fixture.detectChanges();

    expect(heads(fixture)).toEqual([{ name: 'waiting for a runner', badge: 'waiting' }]);
  });
});
