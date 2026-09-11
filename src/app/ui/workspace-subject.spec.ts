import { describe, expect, it } from 'vitest';

import {
  workspaceSubject,
  workspaceSubjectLabel,
  workspaceSubjectPath,
} from './workspace-subject';

const row = (over: Partial<Parameters<typeof workspaceSubject>[0]> = {}) => ({
  ticketId: null,
  epicId: null,
  branch: null,
  ...over,
});

describe('workspaceSubject', () => {
  it('is null for a workspace nobody dispatched', () => {
    expect(workspaceSubject(row({ branch: 'adhoc-changes' }))).toBeNull();
  });

  it('is null for a service that does not answer the fields at all', () => {
    // `undefined` is a deployed qits-workspaces that predates them, not a hand-made workspace —
    // and the two render the same, because neither has a reference to show.
    expect(workspaceSubject({ branch: 'ticket/x' } as never)).toBeNull();
  });

  it('reads the slug off the branch the dispatch cut', () => {
    expect(workspaceSubject(row({ ticketId: 't-1', branch: 'ticket/fix-login' }))).toEqual({
      kind: 'ticket',
      id: 't-1',
      slug: 'fix-login',
    });
  });

  it('reads the hyphenated branch a literal `ticket` ref forces, which is the same workspace', () => {
    expect(workspaceSubject(row({ epicId: 'e-1', branch: 'epic-planning' }))).toEqual({
      kind: 'epic',
      id: 'e-1',
      slug: 'planning',
    });
  });

  it('keeps the id when the branch spells no slug', () => {
    // The field is the durable fact; the branch is only where an address comes from. A workspace
    // adopted onto some other branch still says what it is for.
    expect(workspaceSubject(row({ ticketId: 't-2', branch: 'main' }))).toEqual({
      kind: 'ticket',
      id: 't-2',
      slug: null,
    });
  });

  it('treats a blank id as no subject', () => {
    expect(workspaceSubject(row({ ticketId: '   ', branch: 'ticket/x' }))).toBeNull();
  });

  it('reads a row naming both as the ticket, rather than rendering nothing', () => {
    // No caller sends both and the schema deliberately does not forbid it, so this is a stable
    // answer to a case that should not arise rather than a rule.
    const subject = workspaceSubject(row({ ticketId: 't-3', epicId: 'e-3', branch: 'ticket/both' }));
    expect(subject?.kind).toBe('ticket');
    expect(subject?.id).toBe('t-3');
  });
});

describe('workspaceSubjectLabel', () => {
  it('names the kind and the slug, never the id', () => {
    expect(workspaceSubjectLabel({ kind: 'ticket', id: 't-1', slug: 'fix-login' })).toBe(
      'Ticket fix-login',
    );
    expect(workspaceSubjectLabel({ kind: 'epic', id: 'e-1', slug: null })).toBe('Epic');
  });
});

describe('workspaceSubjectPath', () => {
  it('sends a ticket to its own page', () => {
    expect(workspaceSubjectPath({ kind: 'ticket', id: 't-1', slug: 'fix login' })).toBe(
      'tickets/fix%20login',
    );
  });

  it('sends an epic to the board, because qits-projects serves no epic detail route', () => {
    expect(workspaceSubjectPath({ kind: 'epic', id: 'e-1', slug: 'planning' })).toBe('epics');
  });

  it('has nothing to compose for a ticket with no slug', () => {
    expect(workspaceSubjectPath({ kind: 'ticket', id: 't-1', slug: null })).toBeNull();
  });
});
