import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QITS_NAVIGATION, toNavTree, type QitsNavTree } from '@qits/ui-components';
import { SpeechApi } from './speech-api';

const STT_ORIGIN = 'https://stt.qits.example';

/**
 * qits-stt, which is one route with one field either way. It now has its own host
 * (`stt.<domain>`) and the edge no longer routes its paths on this one, so the call goes to the
 * origin the navigation names, carries the session, and waits for the navigation to answer rather
 * than firing a relative path at this host first.
 */
describe('SpeechApi', () => {
  let tree: WritableSignal<QitsNavTree | undefined>;
  let api: SpeechApi;
  let http: HttpTestingController;

  beforeEach(() => {
    tree = signal<QitsNavTree | undefined>(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: QITS_NAVIGATION, useValue: { tree, failed: signal(false) } },
      ],
    });
    api = TestBed.inject(SpeechApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function answer(applications?: Record<string, { origin: string }>): void {
    tree.set(toNavTree({ slots: {}, applications }));
    TestBed.tick();
  }

  /** Lets the awaited URL resolve, so a request that is going out has gone out. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('asks nothing before the navigation says where qits-stt is', async () => {
    void api.transcribe('UklGRg==');
    TestBed.tick();
    await settle();
    http.expectNone(() => true);
    answer({ 'qits-stt': { origin: STT_ORIGIN } });
    await settle();
    http.expectOne(`${STT_ORIGIN}/stt/api/transcriptions`).flush({ text: '' });
  });

  it('posts the clip to qits-stt’s own origin, with the session, and answers the text', async () => {
    answer({ 'qits-stt': { origin: STT_ORIGIN } });
    const answerPromise = api.transcribe('UklGRg==');
    await settle();
    const request = http.expectOne(`${STT_ORIGIN}/stt/api/transcriptions`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ audioBase64: 'UklGRg==' });
    expect(request.request.withCredentials).toBe(true);
    request.flush({ text: 'add a health check' });

    expect(await answerPromise).toBe('add a health check');
  });

  it('reads a missing text field as an empty transcript', async () => {
    answer({ 'qits-stt': { origin: STT_ORIGIN } });
    const answerPromise = api.transcribe('UklGRg==');
    await settle();
    http.expectOne(`${STT_ORIGIN}/stt/api/transcriptions`).flush({});
    expect(await answerPromise).toBe('');
  });

  it('keeps the same-origin path where the navigation names no origin for qits-stt', async () => {
    answer();
    void api.transcribe('UklGRg==');
    await settle();
    http.expectOne('/stt/api/transcriptions').flush({ text: '' });
  });
});
