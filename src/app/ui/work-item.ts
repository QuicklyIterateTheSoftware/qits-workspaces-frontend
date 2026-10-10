import type { AgentDto } from '../api/dto';

/** A qualified id (`qits-617`), split into the project slug and the item number. */
export interface QualifiedId {
  readonly project: string;
  readonly number: number;
}

const QUALIFIED = /^([a-z0-9][a-z0-9-]*)-(\d+)$/i;

/** Read `<projectSlug>-<n>`. Null for anything else, a UUID included. */
export function parseQualifiedId(value: string | null | undefined): QualifiedId | null {
  const text = (value ?? '').trim();
  if (isUuid(text)) {
    return null;
  }
  const match = QUALIFIED.exec(text);
  return match ? { project: match[1].toLowerCase(), number: Number(match[2]) } : null;
}

/** Whether a string is a UUID, the other spelling of a work item. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * Where an agent's work item lives in qits-projects: the project slug and the path under it
 * (`work/<n>`), for `QitsAppLinks.href('qits-projects', path, {project})`. Null when the agent's
 * entity id is not a qualified id, which renders as text without a link.
 */
export function workItemLink(agent: Pick<AgentDto, 'entityId'>): {
  readonly project: string;
  readonly path: string;
} | null {
  const id = parseQualifiedId(agent.entityId);
  return id ? { project: id.project, path: `work/${id.number}` } : null;
}

/** What an agent is called on screen: its work item's qualified id, else its id. */
export function agentLabel(agent: Pick<AgentDto, 'entityId' | 'agentId'>): string {
  return agent.entityId?.trim() || agent.agentId;
}
