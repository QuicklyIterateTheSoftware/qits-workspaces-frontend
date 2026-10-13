import type { QitsBadgeTone } from '@qits/ui-components';
import type { AgentActivityState, AgentDto, AgentState } from '../api/dto';
import { relativeSince } from '../ui/format';

/** How an agent's run state reads. */
export function runStateLabel(agent: Pick<AgentDto, 'runState'>): string {
  switch (agent.runState) {
    case 'RUNNING':
      return 'running';
    case 'YIELDED':
      return 'yielded — idle, terminal stays live';
    case 'QUEUED':
      return 'queued — no free slot yet';
    default:
      return String(agent.runState ?? 'unknown').toLowerCase();
  }
}

/**
 * What the agent waits on, from its open declared waits (qits-1229): `waiting on <labels> · 4m ago`.
 * The age is read from `waitingOnSince`, the oldest open wait's creation, and is left out when the
 * service does not send it. Null when the agent declares no wait.
 */
export function agentWaitLabel(
  agent: Pick<AgentDto, 'waitingOn' | 'waitingOnSince'>,
  now?: Date,
): string | null {
  const on = agent.waitingOn?.trim();
  if (!on) {
    return null;
  }
  return agent.waitingOnSince
    ? `waiting on ${on} · ${relativeSince(agent.waitingOnSince, now)}`
    : `waiting on ${on}`;
}

/**
 * What the agent is doing, from the daemon's hooks. Null when nothing is reported.
 *
 * A waiting agent that declared what it waits on is not waiting on you: with a `waitingOn`, WAITING
 * reads as nothing here, and {@link agentWaitLabel} says what it waits on instead.
 */
export function activityLabel(
  activity: AgentActivityState | null,
  waitingOn?: string | null,
): string | null {
  switch (activity) {
    case 'BUSY':
      return 'working';
    case 'WAITING':
      return waitingOn?.trim() ? null : 'waiting on you';
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
