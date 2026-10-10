import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';

/**
 * An agent's prompt draft, on the **host** rather than the daemon (`/workspaces/api/agents/{id}/…`).
 *
 * The draft is work product and must outlive the container: a recreate throws the daemon's memory
 * away, the half-written prompt stays. Tab order, by contrast, is device ergonomics and lives in the
 * browser.
 */

/**
 * The draft as the host stores it.
 *
 * Two fields carry the composition and they are not duplicates. `content` is an **opaque blob whose
 * schema this client owns** — the host validates only that it is well-formed JSON — and it holds the
 * prompt text together with the picked context that produced it, so a restored draft restores the
 * chips too. `serializedPrompt` is the flattened text, readable by a server that knows nothing about
 * the client's schema, and it is what the agent is eventually handed.
 *
 * `updatedAt` is the dedup key. The value returned by a save is byte-identical to the one a later
 * read answers, so a client that remembers what it last wrote can tell its own `prompt-draft` echo
 * from another device's save without a second field.
 */
export interface PromptDraftDto {
  readonly content: string;
  readonly serializedPrompt?: string;
  readonly promptVersion?: number;
  readonly lastRunAt?: string;
  readonly lastRunPromptVersion?: number;
  readonly lastRunCommandId?: string;
  readonly updatedAt: string;
}

interface DraftResponse {
  readonly draft: PromptDraftDto;
}

@Injectable({ providedIn: 'root' })
export class PromptDraftApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /**
   * The saved draft, or null when there has never been one.
   *
   * **A never-saved draft is a 404, not an empty body**, and the difference is the whole restored-
   * draft hint: "nothing was ever composed here" and "something was, and here it is" are different
   * screens. A 404 is therefore translated rather than thrown — every other failure is not, because
   * a 503 that read as "no draft" would quietly offer a blank box over work that still exists.
   *
   * The host answers 404 for "no such agent" too. Both read as "no draft" here: the page has already
   * decided whether the agent exists.
   */
  async draft(agentId: string): Promise<PromptDraftDto | null> {
    try {
      const answer = await firstValueFrom(this.http.get<DraftResponse>(this.url(agentId)));
      return answer.draft ?? null;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Upsert the draft, and answer it as persisted.
   *
   * The answer is used rather than discarded: the caller needs the DB-assigned `updatedAt` to
   * recognise its own echo on the `prompt-draft` hint. A 400 means `content` is not well-formed
   * JSON, a 413 means the two fields together exceed the 2 MB cap, and a 404 means there is no such
   * agent.
   */
  async save(agentId: string, content: string, serializedPrompt: string): Promise<PromptDraftDto> {
    const answer = await firstValueFrom(
      this.http.put<DraftResponse>(this.url(agentId), { content, serializedPrompt }),
    );
    return answer.draft;
  }

  /** Throw the draft away. Answers 204 whether or not there was one, so this never 404s on absence. */
  async discard(agentId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.url(agentId)));
  }

  private url(agentId: string): string {
    return `${this.base}/workspaces/api/agents/${encodeURIComponent(agentId)}/prompt-draft`;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: number }).status === 404
  );
}
