import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CommandDto } from '../../api/commands-api';
import { AgentSignIn, signedOutHarness } from './agent-sign-in';

const command = (over: Partial<CommandDto> & Pick<CommandDto, 'id'>): CommandDto => ({
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: 'Claude sign-in',
  status: 'RUNNING',
  interactive: true,
  kind: 'TERMINAL',
  launchedAt: '2026-09-09T10:00:00Z',
  agentSessions: [],
  ...over,
});

const settle = async () => {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
  }
};

/** "Nobody is signed in", read off the harness report, and the door out of it. */
describe('AgentSignIn', () => {
  describe('signedOutHarness', () => {
    const report = [
      { harness: 'CLAUDE' as const, authenticated: true },
      { harness: 'KIMI' as const, authenticated: false, authDetail: 'Run kimi login.' },
    ];

    it('names the agent’s own harness when nobody signed it in', () => {
      const out = signedOutHarness(report, 'KIMI');
      expect(out?.harness).toBe('KIMI');
      expect(out?.message).toContain('Kimi Code');
      expect(out?.message).toContain('Run kimi login.');
    });

    it('says nothing when the agent’s harness is signed in, whatever the others say', () => {
      expect(signedOutHarness(report, 'CLAUDE')).toBeNull();
    });

    it('falls back to any signed-out harness when the agent names none', () => {
      expect(signedOutHarness(report, null)?.harness).toBe('KIMI');
      expect(signedOutHarness([], null)).toBeNull();
    });
  });

  describe('the door', () => {
    let http: HttpTestingController;
    let signIn: AgentSignIn;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      http = TestBed.inject(HttpTestingController);
      signIn = TestBed.inject(AgentSignIn);
    });

    afterEach(() => http.verify());

    it('opens one terminal for the reported harness, and shows it', async () => {
      signIn.report({ harness: 'KIMI', message: 'signed out' });

      void signIn.open(7);
      await settle();
      const door = http.expectOne('/workspaces/container/7/agents/sign-in');
      expect(door.request.body).toEqual({ agentType: 'KIMI' });
      door.flush({ command: command({ id: 'login9' }) });
      await settle();

      expect(signIn.visibleCommandId()).toBe('login9');

      // A second press keeps the open one: two terminals would race for one credential file.
      void signIn.open(7);
      await settle();
      http.expectNone('/workspaces/container/7/agents/sign-in');
    });

    it('shows nothing when the door would not open, and says why', async () => {
      signIn.report({ harness: 'CLAUDE', message: 'signed out' });

      void signIn.open(7);
      await settle();
      http
        .expectOne('/workspaces/container/7/agents/sign-in')
        .flush({ message: 'No such endpoint' }, { status: 404, statusText: 'Not Found' });
      await settle();

      expect(signIn.visibleCommandId()).toBeNull();
      expect(signIn.problem()).toContain('404');
      expect(signIn.refusal()).not.toBeNull();
    });

    it('forgets the terminal and the notice together when it exits', async () => {
      signIn.report({ harness: 'CLAUDE', message: 'signed out' });
      void signIn.open(7);
      await settle();
      http.expectOne('/workspaces/container/7/agents/sign-in').flush({
        command: command({ id: 'login1' }),
      });
      await settle();

      signIn.finished();

      expect(signIn.refusal()).toBeNull();
      expect(signIn.commandId()).toBeNull();
    });
  });
});
