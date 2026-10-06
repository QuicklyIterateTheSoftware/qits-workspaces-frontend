import type { WorkspaceDto } from '../api/dto';

/**
 * Whether a workspace is an ordinary row still running "on the platform host" rather than on a
 * workspace runner — the population qits-777's move door exists for, and the one computation both
 * the detail view's status strip and the overview's list need to agree on.
 *
 * Three exclusions, each a reason the move either does not apply or makes no sense: a `RUNNER` row
 * has already moved; an `admin` row holds the host's docker socket and stays on the host by design;
 * the one `editor` row is the platform's shared editor container, which rides no particular piece of
 * work. `placement` absent reads as `DIRECT`, and `admin`/`editor` absent read as `false` — the same
 * optional-field convention every one of the three already follows on the wire.
 */
export function isDirectRegular(workspace: WorkspaceDto): boolean {
  return (workspace.placement ?? 'DIRECT') === 'DIRECT' && !workspace.admin && !workspace.editor;
}

/**
 * Whether a DIRECT regular row's working tree is dirty — the move's hardest refusal, and the same
 * fact `recreateBlocked` already reads off `clean`.
 */
export function isDirty(workspace: WorkspaceDto): boolean {
  return workspace.clean === false;
}

/**
 * Whether a DIRECT regular row's tree is clean but its head is not provably on the git host yet —
 * the move's second refusal. Only asked once `clean` is known `true`: a dirty tree is refused for
 * being dirty, not for being unpushed on top of that.
 */
export function isUnpushed(workspace: WorkspaceDto): boolean {
  return workspace.clean === true && workspace.pushed === false;
}

/**
 * Whether a DIRECT regular row cannot report its tree at all — not a refusal, a hint. `clean: null`
 * is a disconnected daemon's "I cannot say"; `pushed` missing or `null` is the same absence, and an
 * older service that has never sent the field reads exactly like a service that sent `null`.
 */
export function isMoveUnknown(workspace: WorkspaceDto): boolean {
  return workspace.clean === null || workspace.pushed === null || workspace.pushed === undefined;
}
