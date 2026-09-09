import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { WorkspaceEvents } from '../../api/workspace-events';
import { PickedContext } from './picked-context';
import { DRAFT_DEBOUNCE_MS, PromptPanel } from './prompt-panel';
import { SPEECH_RUNTIME, type SpeechRuntime } from './speech-runtime';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  close(): void {
    this.readyState = 2;
  }
}

/** Recording is unavailable here, which is the state jsdom would honestly report. */
const NO_MICROPHONE: SpeechRuntime = {
  supported: () => false,
  capture: () => Promise.reject(new Error('no microphone in jsdom')),
};

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PromptPanel],
  template: `<app-prompt-panel
    [workspaceRowId]="workspaceRowId()"
    [preamble]="preamble()"
    (launched)="launched.set($event.id)"
  />`,
})
class PanelHost {
  readonly workspaceRowId = signal(7);
  readonly preamble = signal<string | null>('Speed up the export');
  readonly launched = signal<string | null>(null);
}

const DRAFT_URL = '/workspaces/api/workspaces/7/prompt-draft';

/**
 * The composition panel: what it reads, what it saves, and the one rule that must survive every
 * later simplification.
 *
 * **On load this panel reads 1** — `GET /workspaces/api/workspaces/{id}/prompt-draft` — and a 404 is
 * a state rather than a failure.
 */
describe('PromptPanel', () => {
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;
  let http: HttpTestingController;
  let events: WorkspaceEvents;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // The reference row's jump is a URL write, like every other cross-tab jump on this page.
        provideRouter([]),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
        { provide: SPEECH_RUNTIME, useValue: NO_MICROPHONE },
      ],
    });
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    events = TestBed.inject(WorkspaceEvents);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The prompt box: the draft, and the only thing saved, flushed or launched. */
  const text = (): HTMLTextAreaElement =>
    fixture.nativeElement.querySelector('textarea.prompt') as HTMLTextAreaElement;

  /** The transcript box: what has been dictated, and nothing else. */
  const transcript = (): HTMLTextAreaElement =>
    fixture.nativeElement.querySelector('textarea.transcript') as HTMLTextAreaElement;

  const into = (box: HTMLTextAreaElement, value: string) => {
    box.value = value;
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const type = (value: string) => into(text(), value);

  const dictate = (value: string) => into(transcript(), value);

  /**
   * Let the request chain land, then render.
   *
   * Several awaits deep: a client call goes through the daemon transport's reachability wrapper and
   * then the panel's own handler, so one microtask turn regularly returns mid-chain.
   */
  const settle = async () => {
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  };

  /** Open the panel and answer its one read with "never saved". */
  const opened = async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();
  };

  it('reads exactly one thing on load: the saved draft', async () => {
    fixture.detectChanges();
    const request = http.expectOne(DRAFT_URL);
    expect(request.request.method).toBe('GET');
    request.flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    http.verify();
  });

  it('says nothing about a draft that was never saved', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(fixture.nativeElement.textContent).not.toContain('Restored draft');
    expect(text().value).toBe('');
  });

  it('restores a saved draft and announces it with a way out', async () => {
    // Cheap insurance against week-old context silently riding into a launch.
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({
      draft: {
        content: JSON.stringify({
          text: 'last week’s idea',
          references: [{ path: 'src/main.ts', startLine: 1, endLine: 2, excerpt: 'bootstrap();' }],
          elements: [],
        }),
        updatedAt: '2026-08-01T09:00:00Z',
      },
    });
    await settle();

    expect(text().value).toBe('last week’s idea');
    expect(fixture.nativeElement.textContent).toContain('Restored draft');
    expect(TestBed.inject(PickedContext).references()).toHaveLength(1);
  });

  it('opens a picked reference in the viewer, at the lines it stands for', async () => {
    // The designed consumer of the file browser's exact-range entry point: a row that could only be
    // pasted into a prompt would make the user find the code again by hand.
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({
      draft: {
        content: JSON.stringify({
          text: '',
          references: [
            { path: 'service/src/App.java', startLine: 12, endLine: 20, excerpt: 'run();' },
          ],
          elements: [],
        }),
        updatedAt: '2026-08-01T09:00:00Z',
      },
    });
    await settle();

    (fixture.nativeElement.querySelector('button.open') as HTMLButtonElement).click();
    await settle();

    const url = TestBed.inject(Router).url;
    expect(url).toContain('tab=files');
    expect(url).toContain('path=service%2Fsrc%2FApp.java');
    expect(url).toContain('lines=12-20');
  });

  it('drops the restored hint on the first edit', async () => {
    fixture.detectChanges();
    http
      .expectOne(DRAFT_URL)
      .flush({ draft: { content: '{"text":"old"}', updatedAt: '2026-08-01T09:00:00Z' } });
    await settle();
    expect(fixture.nativeElement.textContent).toContain('Restored draft');

    type('mine now');
    expect(fixture.nativeElement.textContent).not.toContain('Restored draft');
  });

  it('saves on a debounce, not on a keystroke', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('a');
    type('ab');
    type('abc');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1);
    http.expectNone(DRAFT_URL);

    vi.advanceTimersByTime(1);
    const save = http.expectOne(DRAFT_URL);
    expect(save.request.method).toBe('PUT');
    expect(save.request.body.serializedPrompt).toBe('abc');
    expect(JSON.parse(save.request.body.content).text).toBe('abc');
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();
  });

  it('marks the draft dirty when a save fails, so the next edit retries', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('work');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    http
      .expectOne(DRAFT_URL)
      .flush({ message: 'too big' }, { status: 413, statusText: 'Payload Too Large' });
    await settle();

    expect(fixture.nativeElement.textContent).toContain('Not saved');
    // The box still holds the work. Losing a keystroke to a 413 is not a thing a text box may do.
    expect(text().value).toBe('work');
  });

  it('ignores its own prompt-draft echo, recognised by updatedAt', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('mine');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    const save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();

    // The save fires the hint. A blind refetch here would fight the box on every debounce.
    events.invalidateAll();
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ draft: { content: '{"text":"mine"}', updatedAt: 'T1' } });
    await settle();

    expect(text().value).toBe('mine');
  });

  it('adopts another device’s save, but only when there is nothing local to lose', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    events.invalidateAll();
    fixture.detectChanges();
    http
      .expectOne(DRAFT_URL)
      .flush({ draft: { content: '{"text":"from the laptop"}', updatedAt: 'T9' } });
    await settle();

    expect(text().value).toBe('from the laptop');
  });

  it('does not refetch over an unsaved edit', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('half a sentence');
    events.invalidateAll();
    fixture.detectChanges();
    http.expectNone((request) => request.method === 'GET' && request.url === DRAFT_URL);

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    const save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();
  });

  it('offers nothing to promote until something has been dictated', async () => {
    await opened();

    expect(fixture.nativeElement.textContent).not.toContain('Refine into prompt');
    expect(fixture.nativeElement.textContent).not.toContain('Use transcript as-is');

    dictate('some words');
    expect(fixture.nativeElement.textContent).toContain('Refine into prompt');
    expect(fixture.nativeElement.textContent).toContain('Use transcript as-is');
  });

  it('refines the transcript into the prompt box, carrying the preamble', async () => {
    await opened();

    dictate('uh make the export thing go faster i guess');
    // Typing into the transcript is not a draft edit: no debounce is armed by it.
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    http.expectNone(DRAFT_URL);

    press('Refine into prompt');
    await settle();

    const refine = http.expectOne('/workspaces/container/7/prompt-refinements');
    expect(refine.request.body).toEqual({
      transcript: 'uh make the export thing go faster i guess',
      preamble: 'Speed up the export',
    });
    refine.flush({ prompt: 'Make the export faster.' });
    await settle();

    expect(text().value).toBe('Make the export faster.');
    // Promoting moves it: a second round of dictation must not promote the first round again.
    expect(transcript().value).toBe('');

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    const save = http.expectOne(DRAFT_URL);
    expect(save.request.body.serializedPrompt).toBe('Make the export faster.');
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();
  });

  it('promotes the words verbatim on “Use transcript as-is”, with no request', async () => {
    // The same gesture as Refine, without the model call — not a dismissal.
    await opened();

    dictate('say it exactly like this');
    press('Use transcript as-is');
    await settle();

    http.expectNone('/workspaces/container/7/prompt-refinements');
    expect(text().value).toBe('say it exactly like this');
    expect(transcript().value).toBe('');

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    const save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();
  });

  it('appends a promotion rather than replacing what was typed', async () => {
    // A promotion arriving on top of typed work must not be how that work disappears.
    await opened();

    type('first, the context');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    let save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();

    dictate('and then the dictated part');
    press('Use transcript as-is');
    await settle();

    expect(text().value).toBe('first, the context\n\nand then the dictated part');

    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    save = http.expectOne(DRAFT_URL);
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T2' } });
    await settle();
  });

  it('keeps the transcript when the rewrite fails', async () => {
    // Losing dictation to a failed model call would be the worst trade on the panel.
    await opened();

    dictate('the words');
    press('Refine into prompt');
    await settle();

    http
      .expectOne('/workspaces/container/7/prompt-refinements')
      .flush({ message: 'no harness' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    expect(transcript().value).toBe('the words');
    expect(text().value).toBe('');
    expect(fixture.nativeElement.textContent).toContain('The rewrite did not happen');
  });

  it('will not launch on a transcript that was never promoted', async () => {
    // The prompt box is the draft. Dictating is not composing until it has been moved.
    await opened();

    dictate('never promoted');
    press('Start the conversation');
    await settle();

    http.expectNone('/workspaces/container/7/agents');
  });

  it('flushes the draft before it launches', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('build the thing');
    // Deliberately inside the debounce window: the launch must not race it.
    press('Start the conversation');
    await settle();

    const save = http.expectOne(DRAFT_URL);
    expect(save.request.method).toBe('PUT');
    save.flush({ draft: { content: save.request.body.content, updatedAt: 'T1' } });
    await settle();

    const launch = http.expectOne('/workspaces/container/7/agents');
    // The surface rides the body. This request is byte-identical to the refining route's in
    // qits-projects-frontend without it, so it is the only thing that says which chat this is.
    expect(launch.request.body).toEqual({
      scope: 'REPOSITORY',
      surface: 'workspace.chat',
      mode: 'CHAT',
      initialContext: 'build the thing',
      deliverTaskPrompt: false,
    });
    launch.flush({ command: { id: 'cmd-9', kind: 'CHAT', status: 'RUNNING' } });
    await settle();

    expect(host.launched()).toBe('cmd-9');
  });

  it('says nobody is signed in, and offers the terminal instead of opening one', async () => {
    // The bug this closes: the launch used to *become* a login terminal and this panel handed the
    // caller a `TERMINAL` command to attach a conversation to. Nothing in the answer said so.
    await opened();

    type('build the thing');
    press('Start the conversation');
    await settle();
    http.expectOne(DRAFT_URL).flush({ draft: { content: '{}', updatedAt: 'T1' } });
    await settle();

    http.expectOne('/workspaces/container/7/agents').flush(
      {
        message:
          'Nobody has signed Claude Code in on this platform’s shared credential volume, so this' +
          ' session cannot start. Open the Claude Code sign-in terminal to complete it once for' +
          ' every container on the volume.',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(host.launched()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Nobody has signed Claude Code in');
    // Said plainly, and not as the generic "the agent did not start" this used to fall through to.
    expect(fixture.nativeElement.textContent).not.toContain('The agent did not start');

    // And the door is a press, which is the whole difference.
    press('Open the sign-in terminal');
    await settle();
    const door = http.expectOne('/workspaces/container/7/agents/sign-in');
    expect(door.request.body).toEqual({ agentType: 'CLAUDE' });
    door.flush({ command: { id: 'login1', actionName: 'Claude sign-in', agentSessions: [] } });
    await settle();
  });

  it('aborts the launch when the flush fails, and says why', async () => {
    // Launching with the wrong prompt is worse than not launching — and a draft that failed to save
    // is work about to be lost.
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    type('build the thing');
    press('Start the conversation');
    await settle();

    http
      .expectOne(DRAFT_URL)
      .flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await settle();

    http.expectNone('/workspaces/container/7/agents');
    expect(fixture.nativeElement.textContent).toContain('nothing was launched');
    expect(host.launched()).toBeNull();
  });

  it('discards the draft, its picks and the hint together', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({
      draft: {
        content: JSON.stringify({
          text: 'old',
          references: [{ path: 'a.ts', startLine: 1, endLine: 1, excerpt: 'x' }],
          elements: [],
        }),
        updatedAt: 'T0',
      },
    });
    await settle();

    press('Discard');
    await settle();

    const drop = http.expectOne(DRAFT_URL);
    expect(drop.request.method).toBe('DELETE');
    drop.flush(null, { status: 204, statusText: 'No Content' });
    await settle();

    expect(text().value).toBe('');
    expect(TestBed.inject(PickedContext).references()).toHaveLength(0);
    expect(fixture.nativeElement.textContent).not.toContain('Restored draft');
  });

  it('drops the Record button where recording is impossible, and keeps the rest', async () => {
    // Refinement is a model call over a textarea. A browser with no microphone loses the microphone.
    await opened();

    expect(fixture.nativeElement.textContent).toContain('cannot record audio');
    expect(transcript()).not.toBeNull();

    dictate('typed, not spoken');
    expect(fixture.nativeElement.textContent).toContain('Refine into prompt');
  });

  it('will not launch an empty prompt', async () => {
    fixture.detectChanges();
    http.expectOne(DRAFT_URL).flush({ message: 'none' }, { status: 404, statusText: 'Not Found' });
    await settle();

    press('Start the conversation');
    await settle();
    http.expectNone('/workspaces/container/7/agents');
  });

  function press(label: string): void {
    const button = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((candidate) => candidate.textContent?.trim().startsWith(label));
    if (!button) {
      throw new Error(`No button reading "${label}"`);
    }
    button.click();
    fixture.detectChanges();
  }
});
