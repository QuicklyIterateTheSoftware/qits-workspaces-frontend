import type { QitsBadgeTone } from '@qits/ui-components';
import type { AgentActivityState, AgentDto, AgentState } from '../api/dto';

/** How an agent's run state reads. */
export function runStateLabel(agent: Pick<AgentDto, 'runState'>): string {
  switch (agent.runState) {
    case 'RUNNING':
      return 'running';
    case 'YIELDED':
      return 'yielded — waits for its turn';
    case 'QUEUED':
      return 'queued — no free slot yet';
    default:
      return String(agent.runState ?? 'unknown').toLowerCase();
  }
}

/** What the agent is doing, from the daemon's hooks. Null when nothing is reported. */
export function activityLabel(activity: AgentActivityState | null): string | null {
  switch (activity) {
    case 'BUSY':
      return 'working';
    case 'WAITING':
      return 'waiting on you';
    case 'IDLE':
      return 'idle';
    case 'ENDED':
      return 'ended';
    default:
      return null;
  }
}

/** The badge tone of an agent's lifecycle state. */
export function agentStateTone(state: AgentState): QitsBadgeTone {
  switch (state) {
    case 'ACTIVE':
      return 'success';
    case 'OBSOLETE':
      return 'info';
    default:
      return 'neutral';
  }
}
