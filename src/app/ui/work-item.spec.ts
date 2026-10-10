import { agentLabel, isUuid, parseQualifiedId, workItemLink } from './work-item';

describe('work item helpers', () => {
  it('reads a qualified id, and nothing else', () => {
    expect(parseQualifiedId('qits-617')).toEqual({ project: 'qits', number: 617 });
    expect(parseQualifiedId('my-proj-12')).toEqual({ project: 'my-proj', number: 12 });
    expect(parseQualifiedId('ticket/qits-617')).toBeNull();
    expect(parseQualifiedId('8a5c4a1e-0000-4000-8000-000000000001')).toBeNull();
    expect(parseQualifiedId(null)).toBeNull();
  });

  it('tells a UUID apart', () => {
    expect(isUuid('8a5c4a1e-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('qits-617')).toBe(false);
  });

  it('links a work item into qits-projects by number', () => {
    expect(workItemLink({ entityId: 'qits-617' })).toEqual({ project: 'qits', path: 'work/617' });
    expect(workItemLink({ entityId: null })).toBeNull();
  });

  it('names an agent by its work item, else by its id', () => {
    expect(agentLabel({ entityId: 'qits-617', agentId: 'a1' })).toBe('qits-617');
    expect(agentLabel({ entityId: '', agentId: 'a1' })).toBe('a1');
  });
});
