import { activityLabel, agentStateTone, agentWaitLabel, runStateLabel } from './agent-labels';

const NOW = new Date('2026-10-13T12:00:00Z');

describe('runStateLabel', () => {
  it('explains a yielded and a queued agent, and lowercases anything else', () => {
    expect(runStateLabel({ runState: 'RUNNING' })).toBe('running');
    expect(runStateLabel({ runState: 'YIELDED' })).toBe('yielded — idle, terminal stays live');
    expect(runStateLabel({ runState: 'QUEUED' })).toBe('queued — no free slot yet');
  });
});

describe('agentWaitLabel', () => {
  it('names what the agent waits on and how long it has', () => {
    expect(
      agentWaitLabel(
        {
          waitingOn: 'qits-platform-access-cli-rr-89 (qits-1213)',
          waitingOnSince: '2026-10-13T11:56:00Z',
        },
        NOW,
      ),
    ).toBe('waiting on qits-platform-access-cli-rr-89 (qits-1213) · 4m ago');
  });

  it('leaves the age out when the service does not say when the wait began', () => {
    expect(agentWaitLabel({ waitingOn: 'release of qits-617', waitingOnSince: null }, NOW)).toBe(
      'waiting on release of qits-617',
    );
    expect(agentWaitLabel({ waitingOn: 'release of qits-617' }, NOW)).toBe(
      'waiting on release of qits-617',
    );
  });

  it('says nothing for an agent with no declared wait, or a service that does not send one', () => {
    expect(agentWaitLabel({ waitingOn: null, waitingOnSince: null }, NOW)).toBeNull();
    expect(
      agentWaitLabel({ waitingOn: '  ', waitingOnSince: '2026-10-13T11:56:00Z' }, NOW),
    ).toBeNull();
    expect(agentWaitLabel({}, NOW)).toBeNull();
  });
});

describe('activityLabel', () => {
  it('names each activity the hooks report', () => {
    expect(activityLabel('BUSY')).toBe('working');
    expect(activityLabel('IDLE')).toBe('idle');
    expect(activityLabel('ENDED')).toBe('ended');
  });

  it('says nothing when nothing is reported', () => {
    expect(activityLabel(null)).toBeNull();
  });

  it('says a waiting agent with no declared wait waits on you', () => {
    expect(activityLabel('WAITING')).toBe('waiting on you');
    expect(activityLabel('WAITING', null)).toBe('waiting on you');
    expect(activityLabel('WAITING', ' ')).toBe('waiting on you');
  });

  it('does not say a waiting agent with a declared wait waits on you', () => {
    expect(activityLabel('WAITING', 'release of qits-617')).toBeNull();
  });

  it('is not changed by a declared wait for any other activity', () => {
    expect(activityLabel('BUSY', 'release of qits-617')).toBe('working');
  });
});

describe('agentStateTone', () => {
  it('reads active as success, obsolete as info and anything else as neutral', () => {
    expect(agentStateTone('ACTIVE')).toBe('success');
    expect(agentStateTone('OBSOLETE')).toBe('info');
    expect(agentStateTone('REMOVED')).toBe('neutral');
  });
});
