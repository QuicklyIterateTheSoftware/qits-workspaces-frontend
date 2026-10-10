import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AgentWorktreesApi } from './agent-worktrees-api';

describe('AgentWorktreesApi', () => {
  it('reads one agent worktree through the container proxy', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const api = TestBed.inject(AgentWorktreesApi);
    const http = TestBed.inject(HttpTestingController);

    const reading = api.worktree(7, 'a1');
    http.expectOne('/workspaces/container/7/agent-worktrees/a1').flush({
      agentId: 'a1',
      path: '/workspace/agents/a1/qits-qits',
      harnessRunning: true,
      commandId: 'cmd-1',
      branches: [],
      dirty: false,
      unpushed: true,
    });
    const worktree = await reading;
    expect(worktree.commandId).toBe('cmd-1');
    expect(worktree.unpushed).toBe(true);
    http.verify();
  });
});
