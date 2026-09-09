import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CommandDto } from '../../api/commands-api';
import { AgentSignIn, isSignInTerminal, signedOutRefusal } from './agent-sign-in';

/** The refusal the harness library throws, verbatim but for the harness it names. */
const refusalFor = (harness: string) =>
  `Nobody has signed ${harness} in on this platform’s shared credential volume, so this session` +
  ` cannot start. Open the ${harness} sign-in terminal to complete it once for every container on` +
  ' the volume.';

const refused = (message: string, status = 409) =>
  new HttpErrorResponse({ error: { message }, status, statusText: 'Conflict' });

const command = (over: Partial<CommandDto> & Pick<CommandDto, 'id'>): CommandDto => ({
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: 'claude',
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

/**
 * "Nobody is signed in", and the door out of it.
 *
 * The two readers are tested hardest, because both stand in for a contract that is not fully landed:
 * the refusal is recognised by its **message** while the workspace daemon has no status mapping for
 * it yet, and the login terminal is recognised by its **name and empty lineage** while that daemon
 * still swaps one in behind a launch's back. Each has a way of being too eager, and each way is a
 * session it would put a sign-in prompt over.
 */
describe('AgentSignIn', () => {
  describe('signedOutRefusal', () => {
    it('recognises the library refusal and reads the harness out of it', () => {
      const claude = signedOutRefusal(refused(refusalFor('Claude Code')));
      expect(claude?.harness).toBe('CLAUDE');
      expect(claude?.message).toContain('sign-in terminal');

      expect(signedOutRefusal(refused(refusalFor('Kimi Code')))?.harness).toBe('KIMI');
    });

    it('leaves every other refusal to the caller, whatever the status', () => {
      // A refusal this cannot recognise must read as the daemon's own sentence. Offering a sign-in
      // for a problem signing in would not fix is the same unhelpful redirection in a new costume.
      expect(signedOutRefusal(refused('fork is not supported by Kimi Code', 400))).toBeNull();
      expect(signedOutRefusal(refused('Internal error', 500))).toBeNull();
      expect(signedOutRefusal(new Error('offline'))).toBeNull();
    });

    it('names no harness rather than guessing one when the words do not', () => {
      const anonymous = signedOutRefusal(refused('Nobody has signed the coding agent in.'));
      expect(anonymous).not.toBeNull();
      expect(anonymous?.harness).toBeNull();
    });
  });

  describe('isSignInTerminal', () => {
    it('needs the name and the empty lineage to agree', () => {
      expect(isSignInTerminal(command({ id: 'a', actionName: 'Claude sign-in' }))).toBe(true);
      // A fresh Kimi launch also arrives with no lineage — Kimi cannot pin a session id up front —
      // so lineage alone would put a sign-in notice over a perfectly good agent.
      expect(isSignInTerminal(command({ id: 'b', actionName: 'kimi' }))).toBe(false);
      expect(
        isSignInTerminal(
          command({
            id: 'c',
            actionName: 'Claude sign-in',
            agentSessions: [{ sessionId: 's', source: 'PINNED', recordedAt: 'T' }],
          }),
        ),
      ).toBe(false);
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

    it('holds a terminal a launch answered with, and shows it only on a press', async () => {
      signIn.adopt(command({ id: 'login1', actionName: 'Claude sign-in' }));

      expect(signIn.refusal()).not.toBeNull();
      // The whole point: it exists, and it is not on screen.
      expect(signIn.commandId()).toBe('login1');
      expect(signIn.visibleCommandId()).toBeNull();

      void signIn.open(7);
      await settle();

      // No second REPL: two of them would race for the same credential file.
      http.expectNone('/workspaces/container/7/agents/sign-in');
      expect(signIn.visibleCommandId()).toBe('login1');
    });

    it('opens one terminal, names the refused harness, and shows what it opened', async () => {
      signIn.refuse(refused(refusalFor('Kimi Code')));

      void signIn.open(7);
      await settle();
      const door = http.expectOne('/workspaces/container/7/agents/sign-in');
      expect(door.request.body).toEqual({ agentType: 'KIMI' });
      door.flush({ command: command({ id: 'login9', actionName: 'Kimi sign-in' }) });
      await settle();

      expect(signIn.visibleCommandId()).toBe('login9');

      // Pressing again reveals the same one rather than launching a second.
      void signIn.open(7);
      await settle();
      http.expectNone('/workspaces/container/7/agents/sign-in');
    });

    it('shows nothing when the door itself would not open, and says why', async () => {
      signIn.refuse(refused(refusalFor('Claude Code')));

      void signIn.open(7);
      await settle();
      http
        .expectOne('/workspaces/container/7/agents/sign-in')
        .flush({ message: 'No such endpoint' }, { status: 404, statusText: 'Not Found' });
      await settle();

      expect(signIn.visibleCommandId()).toBeNull();
      expect(signIn.problem()).toContain('404');
      // The refusal survives the failed door: nobody is still signed in.
      expect(signIn.refusal()).not.toBeNull();
    });

    it('forgets the terminal and the refusal together when it exits, and replays nothing', async () => {
      signIn.adopt(command({ id: 'login1', actionName: 'Claude sign-in' }));
      void signIn.open(7);
      await settle();

      signIn.finished();

      expect(signIn.refusal()).toBeNull();
      expect(signIn.commandId()).toBeNull();
      expect(signIn.showing()).toBe(false);
      http.verify();
    });
  });
});
