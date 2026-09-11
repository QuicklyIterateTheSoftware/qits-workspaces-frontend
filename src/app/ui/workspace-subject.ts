import type { WorkspaceDto } from '../api/dto';

/** What kind of thing a dispatched workspace is for. */
export type WorkspaceSubjectKind = 'ticket' | 'epic';

/**
 * What a **dispatched** workspace is for, as this page renders it: a short reference to the
 * qits-projects row it was dispatched from.
 *
 * <p>`id` is what qits-workspaces stores and `slug` is what an address is spelled with, which is why
 * both are here and neither is derivable from the other on this side. qits-projects' URL grammar
 * names slugs — `/<project>/tickets/<slug>` — and this application cannot turn an id into one: there
 * is no cross-application read, and inventing one for a link would be a request per row in a list
 * that redraws on a poll. The workspace's own **branch** is where the slug comes from, and it is not
 * a guess: a dispatch cut that branch from the slug in the same call that set the id.
 */
export interface WorkspaceSubject {
  readonly kind: WorkspaceSubjectKind;
  /** The qits-projects row id — the durable fact, carried whether or not a link can be composed. */
  readonly id: string;
  /** The address segment, or `null` when the branch does not spell one. */
  readonly slug: string | null;
}

/** The part of a workspace this module reads. A row, or anything shaped like one. */
type Dispatched = Pick<WorkspaceDto, 'ticketId' | 'epicId' | 'branch'>;

/**
 * The workspace's subject, or `null` for one nobody dispatched.
 *
 * `null` is the ordinary answer: a workspace a person created by hand names no subject and states
 * its scope in its preamble, and so does every workspace that predates the fields.
 *
 * A row naming both — which no caller sends and the schema deliberately does not forbid — reads as
 * the ticket. One reference is the whole point of rendering one, and picking the first is a stable
 * answer where refusing to render anything would be a workspace that says nothing at all.
 */
export function workspaceSubject(workspace: Dispatched | null | undefined): WorkspaceSubject | null {
  if (!workspace) {
    return null;
  }
  const ticketId = trimmed(workspace.ticketId);
  if (ticketId) {
    return { kind: 'ticket', id: ticketId, slug: slugFrom(workspace.branch, 'ticket') };
  }
  const epicId = trimmed(workspace.epicId);
  if (epicId) {
    return { kind: 'epic', id: epicId, slug: slugFrom(workspace.branch, 'epic') };
  }
  return null;
}

/**
 * What the reference reads as — `Ticket fix-login`, or bare `Ticket` where the branch spells no
 * slug. Never the id: it is qits-projects' vocabulary and says nothing to a person.
 */
export function workspaceSubjectLabel(subject: WorkspaceSubject): string {
  const noun = subject.kind === 'ticket' ? 'Ticket' : 'Epic';
  return subject.slug ? `${noun} ${subject.slug}` : noun;
}

/**
 * The path inside qits-projects, for `QitsAppLinks.href('qits-projects', …, {project})` — or `null`
 * when there is nothing honest to compose, which the caller renders as the label alone.
 *
 * A ticket has a page of its own; **an epic has no detail route**, so an epic reference opens the
 * project's epics board. That is the whole of the asymmetry and it is that application's shape
 * rather than a decision made here.
 */
export function workspaceSubjectPath(subject: WorkspaceSubject): string | null {
  if (subject.kind === 'epic') {
    return 'epics';
  }
  return subject.slug ? `tickets/${encodeURIComponent(subject.slug)}` : null;
}

/**
 * `ticket/fix-login` → `fix-login`. Both separators are read: a dispatch onto a repository that
 * already holds a literal `ticket` ref cannot create `ticket/*` — git stores refs as files — so
 * qits-workspaces flips the first segment's separator to `-` rather than failing on a push. The
 * workspace is the same workspace either way.
 */
function slugFrom(branch: string | null, kind: WorkspaceSubjectKind): string | null {
  if (!branch) {
    return null;
  }
  for (const separator of ['/', '-']) {
    const prefix = `${kind}${separator}`;
    if (branch.startsWith(prefix) && branch.length > prefix.length) {
      return branch.slice(prefix.length);
    }
  }
  return null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}
