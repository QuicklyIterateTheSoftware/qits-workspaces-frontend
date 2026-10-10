import { Injectable, computed, inject, signal } from '@angular/core';
import { FilesApi, type DetectionDto } from './files-api';

/** Which agent's worktree a detection describes. */
export interface DetectionScope {
  readonly workspaceRowId: number;
  readonly agentId: string;
}

function keyOf(scope: DetectionScope): string {
  return `${scope.workspaceRowId}/${scope.agentId}`;
}

/**
 * The one detection answer, shared between the file browser and the plugin recommender.
 *
 * The file browser owns the fetch (its read is gated on a generation token against `/files`) and
 * {@link publish}es what it got; the recommender {@link ensure}s, paying for one fetch only when
 * nothing is held. A detection belongs to one agent's worktree (qits-1152).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceDetection {
  private readonly api = inject(FilesApi);

  private readonly key = signal('');
  private readonly held = signal<DetectionDto | null>(null);
  private asking: Promise<void> | null = null;

  /** The detection on hand, or null while nobody has read one for this agent. */
  readonly detection = this.held.asReadonly();

  /** Every framework id detected anywhere in the tree, deduplicated. What the recommender reads. */
  readonly frameworkIds = computed<ReadonlySet<string>>(() => {
    const detection = this.held();
    const ids = new Set<string>();
    for (const project of detection?.projects ?? []) {
      ids.add(project.frameworkId);
    }
    for (const framework of detection?.frameworks ?? []) {
      ids.add(framework.frameworkId);
    }
    return ids;
  });

  /** Point at an agent's worktree. A change drops what was held. */
  use(scope: DetectionScope): void {
    const key = keyOf(scope);
    if (this.key() === key) {
      return;
    }
    this.key.set(key);
    this.held.set(null);
    this.asking = null;
  }

  /**
   * The file browser's own read, handed on. An unclaimed entry adopts the scope; a claimed one keeps
   * its own, so a late answer for an agent the page has left cannot repoint it.
   */
  publish(scope: DetectionScope, detection: DetectionDto): void {
    const key = keyOf(scope);
    if (this.key() === '') {
      this.key.set(key);
    }
    if (this.key() === key) {
      this.held.set(detection);
    }
  }

  /**
   * Read one, but only if nothing has. A failure is swallowed: detection drives a badge, and a
   * recommender that cannot sort is still a working one.
   */
  async ensure(scope: DetectionScope): Promise<void> {
    this.use(scope);
    if (scope.workspaceRowId <= 0 || !scope.agentId || this.held() !== null) {
      return;
    }
    this.asking ??= this.api
      .detection(scope.workspaceRowId, scope.agentId)
      .then((detection) => this.publish(scope, detection))
      .catch(() => undefined)
      .finally(() => {
        this.asking = null;
      });
    await this.asking;
  }
}
