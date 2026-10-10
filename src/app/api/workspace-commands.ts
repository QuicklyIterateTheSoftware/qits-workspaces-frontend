import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { CommandsApi, type CommandDto } from './commands-api';
import { WorkspaceEvents } from './workspace-events';

/**
 * The one command-list entry, owned in one place.
 *
 * The Chat and Terminal tabs both read this list, each for its agent's own command; one signal and
 * one fetch per container keeps them from asking twice. It refreshes itself on the `commands` hint,
 * also while its tab is hidden, so a chat started or ended elsewhere is noticed.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCommands {
  private readonly api = inject(CommandsApi);
  private readonly events = inject(WorkspaceEvents);

  private readonly workspaceRowId = signal(0);
  private readonly state = signal<Loadable<readonly CommandDto[]>>(IDLE);

  /** Every command this container has run, newest first. */
  readonly commands = this.state.asReadonly();

  /** Which workspace the list on hand belongs to, so a reader can tell it apart from a stale one. */
  readonly loadedFor = computed(() => this.workspaceRowId());

  private readonly hints = this.events.invalidations('commands');

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      this.hints();
      untracked(() => void this.load(workspaceRowId));
    });
  }

  /**
   * Read this workspace's commands, and keep reading them.
   *
   * Idempotent for the same id, so every reader may call it on every render; a different id moves
   * the entry and blanks it first, because one workspace's runs are not a stale view of another's.
   */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.state.set(workspaceRowId > 0 ? LOADING : IDLE);
    this.workspaceRowId.set(workspaceRowId);
  }

  /** Re-read now. For a mutation that settles: the truth is refetched, not patched. */
  async refresh(): Promise<void> {
    await this.load(this.workspaceRowId());
  }

  /** Whether the list has been read at all. `idle` is not "nothing running", it is "not asked". */
  readonly asked = computed(() => this.state().kind !== 'idle');

  private async load(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      this.state.set(IDLE);
      return;
    }
    try {
      const commands = await this.api.commands(workspaceRowId);
      // A late answer for a workspace that has since been left is dropped rather than shown.
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(ready(commands));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(failed(error));
      }
    }
  }
}
