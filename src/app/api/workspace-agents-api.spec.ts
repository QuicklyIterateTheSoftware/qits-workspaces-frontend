import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspaceAgentsApi } from './workspace-agents-api';

/** The agent doors of qits-workspaces, as qits-1152 shaped them. */
describe('WorkspaceAgentsApi', () => {
  let api: WorkspaceAgentsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(WorkspaceAgentsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists agents from the {agents} envelope, sending only the filters given', async () => {
    const listing = api.agents({ workspaceId: 12 });
    const request = http.expectOne((candidate) => candidate.url === '/workspaces/api/agents');
    expect(request.request.params.get('workspaceId')).toBe('12');
    expect(request.request.params.has('workId')).toBe(false);
    expect(request.request.params.has('state')).toBe(false);
    request.flush({ agents: [{ agentId: 'a1' }] });
    expect((await listing).map((agent) => agent.agentId)).toEqual(['a1']);
  });

  it('reads one agent by id', async () => {
    const reading = api.agent('a1');
    http.expectOne('/workspaces/api/agents/a1').flush({ agentId: 'a1', state: 'ACTIVE' });
    expect((await reading).state).toBe('ACTIVE');
  });

  it('creates an agent for a work item with the body as given', async () => {
    const creating = api.create({
      repositoryId: 'wrapper',
      workId: 'uuid-1',
      entityId: 'qits-617',
      kind: 'TICKET',
      admin: false,
    });
    const request = http.expectOne('/workspaces/api/agents');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      repositoryId: 'wrapper',
      workId: 'uuid-1',
      entityId: 'qits-617',
      kind: 'TICKET',
      admin: false,
    });
    request.flush({ agent: { agentId: 'a1' }, fresh: true, agentLaunch: 'SCHEDULED' });
    expect((await creating).agent.agentId).toBe('a1');
  });

  it('discards plainly first, and with force only when asked', async () => {
    const plain = api.discard('a1');
    const first = http.expectOne('/workspaces/api/agents/a1/discard');
    expect(first.request.body).toEqual({ force: false });
    first.flush(
      { message: 'unpushed work', code: 'AGENT_HAS_LEFTOVER_WORK' },
      { status: 409, statusText: 'Conflict' },
    );
    await expect(plain).rejects.toBeInstanceOf(HttpErrorResponse);

    const forced = api.discard('a1', true);
    const second = http.expectOne('/workspaces/api/agents/a1/discard');
    expect(second.request.body).toEqual({ force: true });
    second.flush({ agentId: 'a1', state: 'REMOVED' });
    expect((await forced).state).toBe('REMOVED');
  });

  it('delivers a turn by work item through the delivery door', async () => {
    const sending = api.deliver('uuid-1', 'carry on');
    const request = http.expectOne('/workspaces/api/agent-dispatches/delivery');
    expect(request.request.body).toEqual({
      workId: 'uuid-1',
      text: 'carry on',
      compactFirst: false,
    });
    request.flush({ agentId: 'a1', delivered: false, launched: false, resumed: true });
    expect((await sending).resumed).toBe(true);
  });

  it('reads open waits from either envelope, and a missing door as none', async () => {
    const bare = api.openWaits('a1');
    http
      .expectOne((candidate) => candidate.url === '/workspaces/api/agents/a1/waits')
      .flush([{ id: 'w1', agentId: 'a1', label: 'release', state: 'OPEN' }]);
    expect((await bare).map((wait) => wait.label)).toEqual(['release']);

    const wrapped = api.openWaits('a1');
    http
      .expectOne((candidate) => candidate.url === '/workspaces/api/agents/a1/waits')
      .flush({
        waits: [
          { id: 'w1', agentId: 'a1', state: 'OPEN' },
          { id: 'w2', agentId: 'a1', state: 'MATCHED' },
        ],
      });
    expect((await wrapped).map((wait) => wait.id)).toEqual(['w1']);

    const missing = api.openWaits('a1');
    http
      .expectOne((candidate) => candidate.url === '/workspaces/api/agents/a1/waits')
      .flush({ message: 'no' }, { status: 404, statusText: 'Not Found' });
    expect(await missing).toEqual([]);
  });
});
