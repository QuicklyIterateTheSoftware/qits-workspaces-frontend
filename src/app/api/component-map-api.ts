import { Injectable, inject } from '@angular/core';
import { agentRoot } from './files-api';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The map that turns a clicked element in the framed app into a component with source files.
 *
 * Angular only today — `framework` says which scanner produced it, and a tree the scanner does not
 * recognise answers an empty list rather than an error.
 *
 * **Fetched once per pick-mode activation, never per pick.** It is the one read on this page that is
 * neither shared nor invalidated by a hint: a map that misses a component created since the last
 * activation simply skips attribution, and paying for a refresh on every click would make the picker
 * slower than the thing it is attributing.
 */

/**
 * One selector a component answers to.
 *
 * **Either half may be absent**, and the daemon's parser is deliberately dumb about it: `app-foo` is
 * element-only, `[appFoo]` attribute-only, `button[appFoo]` both. Anything the parser cannot reduce
 * to those two names is skipped rather than guessed at, so a component matched here is matched for a
 * reason that can be explained.
 */
export interface ComponentSelectorDto {
  readonly element?: string;
  readonly attribute?: string;
}

/** One component, and the files a pick attributed to it should link at. */
export interface ComponentMapEntryDto {
  readonly className: string;
  readonly componentFile: string;
  /** Omitted for an inline template — the component file is then the only place its markup lives. */
  readonly templateFile?: string;
  readonly styleFiles: readonly string[];
  readonly selectors: readonly ComponentSelectorDto[];
}

export interface ComponentMapDto {
  readonly framework: string;
  readonly components: readonly ComponentMapEntryDto[];
}

@Injectable({ providedIn: 'root' })
export class ComponentMapApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  async componentMap(workspaceRowId: number, agentId: string): Promise<ComponentMapDto> {
    return this.daemon.get<ComponentMapDto>(workspaceRowId, `${agentRoot(agentId)}/component-map`);
  }
}
