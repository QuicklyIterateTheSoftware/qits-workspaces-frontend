import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PromptDraftApi } from './prompt-draft-api';

/**
 * The draft's transport, and the one status that is a *state* rather than a failure.
 *
 * A never-saved draft answers 404, not an empty body, and the difference is the whole restored-draft
 * hint: "nothing was ever composed here" and "something was" are different screens.
 */
describe('PromptDraftApi', () => {
  let api: PromptDraftApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PromptDraftApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the draft off the host, not the container proxy', async () => {
    // Host-owned deliberately: a recreate throws the daemon's world away and the half-written prompt
    // has to still be there afterwards.
    const answer = api.draft('a1');
    const request = http.expectOne('/workspaces/api/agents/a1/prompt-draft');
    request.flush({ draft: { content: '{"text":"hi"}', updatedAt: '2026-08-01T09:00:00Z' } });

    expect(request.request.method).toBe('GET');
    expect(await answer).toMatchObject({ updatedAt: '2026-08-01T09:00:00Z' });
  });

  it('answers null for a 404 rather than throwing', async () => {
    const answer = api.draft('a1');
    http
      .expectOne('/workspaces/api/agents/a1/prompt-draft')
      .flush({ message: 'no draft' }, { status: 404, statusText: 'Not Found' });

    expect(await answer).toBeNull();
  });

  it('lets every other failure through, because a 503 is not "no draft"', async () => {
    const answer = api.draft('a1');
    http
      .expectOne('/workspaces/api/agents/a1/prompt-draft')
      .flush({ message: 'down' }, { status: 503, statusText: 'Service Unavailable' });

    await expect(answer).rejects.toBeDefined();
  });

  it('saves both halves and hands back the persisted row', async () => {
    // The answer is used rather than discarded: its `updatedAt` is byte-identical to the one a later
    // read gives, which is what lets the client recognise its own SSE echo.
    const answer = api.save('a1', '{"text":"hi"}', 'hi');
    const request = http.expectOne('/workspaces/api/agents/a1/prompt-draft');
    request.flush({ draft: { content: '{"text":"hi"}', updatedAt: '2026-08-01T09:01:00Z' } });

    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ content: '{"text":"hi"}', serializedPrompt: 'hi' });
    expect((await answer).updatedAt).toBe('2026-08-01T09:01:00Z');
  });

  it('discards with a DELETE that answers no content', async () => {
    const answer = api.discard('a1');
    const request = http.expectOne('/workspaces/api/agents/a1/prompt-draft');
    request.flush(null, { status: 204, statusText: 'No Content' });

    expect(request.request.method).toBe('DELETE');
    await answer;
  });
});
