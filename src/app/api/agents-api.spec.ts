import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AgentsApi, barePluginId } from './agents-api';

/**
 * The container-wide coding-agent reads, and the one verb that has a rule worth a test.
 *
 * **The install path takes the bare id.** The listing reports the marketplace-qualified form and the
 * daemon appends the suffix itself, so sending back what was read is a 400 — a mistake that is
 * invisible until somebody presses Install, which is exactly the kind this belongs in a test.
 */
describe('AgentsApi', () => {
  let api: AgentsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(AgentsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the harnesses and the resolved default', async () => {
    const reading = api.available(7);
    http.expectOne('/workspaces/container/7/agents/available').flush({
      agents: ['CLAUDE', 'KIMI'],
      defaultAgent: 'CLAUDE',
      capabilities: [{ harness: 'CLAUDE', authenticated: false, authDetail: 'run claude login' }],
    });
    const available = await reading;
    expect(available.defaultAgent).toBe('CLAUDE');
    expect(available.capabilities?.[0].authenticated).toBe(false);
  });

  it('installs by the bare id, whichever form the caller had', async () => {
    const installing = api.install(7, 'jdtls-lsp@claude-plugins-official');
    const request = http.expectOne('/workspaces/container/7/agent-plugins/jdtls-lsp/install');
    expect(request.request.method).toBe('POST');
    request.flush({
      installed: [{ pluginId: 'jdtls-lsp@claude-plugins-official', enabled: true }],
    });
    // The answer is the refreshed set, so there is no follow-up read — and there must not be.
    expect(await installing).toHaveLength(1);
  });

  it('refuses an id the marketplace cannot name before it reaches the daemon', async () => {
    await expect(api.install(7, 'Not A Plugin')).rejects.toThrow(/not a plugin id/i);
    http.expectNone(() => true);
  });

  it('strips the marketplace suffix and leaves a bare id alone', () => {
    expect(barePluginId('jdtls-lsp@claude-plugins-official')).toBe('jdtls-lsp');
    expect(barePluginId('jdtls-lsp')).toBe('jdtls-lsp');
  });
});
