import { Injectable, computed, inject, signal } from '@angular/core';
import type { HarnessCapabilitiesDto } from '../../api/agents-api';
import { CommandsApi, type AgentType } from '../../api/commands-api';
import { describeError } from '../../ui/loadable';

/** A harness nobody has signed in on the shared credential volume. */
export interface SignedOut {
  readonly harness: AgentType | null;
  /** What to say, with the daemon's own hint on where to sign in when it gave one. */
  readonly message: string;
}

/**
 * Which harness to report as signed out: the agent's own when it is known, else any.
 *
 * Read off the daemon's harness report (`GET /agents/available` → `capabilities[].authenticated`).
 * The report is a display value and never a gate: the service asks again at every start.
 */
export function signedOutHarness(
  capabilities: readonly HarnessCapabilitiesDto[],
  harness: AgentType | null,
): SignedOut | null {
  const candidates = harness
    ? capabilities.filter((entry) => entry.harness === harness)
    : capabilities;
  const out = candidates.find((entry) => entry.authenticated === false);
  if (!out) {
    return null;
  }
  const name = out.harness === 'KIMI' ? 'Kimi Code' : 'Claude Code';
  const detail = out.authDetail?.trim();
  return {
    harness: out.harness,
    message:
      `Nobody has signed ${name} in on the shared credential volume, so the agent cannot start.` +
      (detail ? ` ${detail}` : ''),
  };
}

/**
 * "Nobody is signed in", and the door out of it: the sign-in terminal.
 *
 * One sign-in serves the whole shared credential volume, so this is a fact about the container and
 * not about one agent. The Terminal tab sets it from the harness report and renders the terminal
 * once somebody presses to open it.
 */
@Injectable({ providedIn: 'root' })
export class AgentSignIn {
  private readonly api = inject(CommandsApi);

  private readonly refusalState = signal<SignedOut | null>(null);
  private readonly terminal = signal<string | null>(null);
  private readonly opening = signal(false);
  private readonly problemText = signal<string | null>(null);

  /** What to say, or null when every harness that matters is signed in. */
  readonly refusal = this.refusalState.asReadonly();

  /** The sign-in terminal that was opened, if one was. */
  readonly commandId = this.terminal.asReadonly();

  /** The sign-in terminal to render. Only ever one somebody pressed to open. */
  readonly visibleCommandId = computed(() => this.terminal());

  /** Whether the door is being opened. */
  readonly busy = this.opening.asReadonly();

  /** What went wrong opening it. */
  readonly problem = this.problemText.asReadonly();

  /** Forget everything. Called when the page points at another workspace. */
  reset(): void {
    this.refusalState.set(null);
    this.terminal.set(null);
    this.problemText.set(null);
    this.opening.set(false);
  }

  /** Take what the harness report says. Null clears it. */
  report(signedOut: SignedOut | null): void {
    this.refusalState.set(signedOut);
  }

  /** Open the sign-in terminal, once. A second press keeps the one that is open. */
  async open(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0 || this.opening() || this.terminal() !== null) {
      return;
    }
    this.opening.set(true);
    this.problemText.set(null);
    try {
      const command = await this.api.launchSignIn(
        workspaceRowId,
        this.refusalState()?.harness ?? undefined,
      );
      this.terminal.set(command.id);
    } catch (error) {
      this.problemText.set(`The sign-in terminal did not open — ${describeError(error)}.`);
    } finally {
      this.opening.set(false);
    }
  }

  /**
   * The terminal has exited: drop it and the notice. Nothing is restarted from here; the service
   * starts the agent again on its next pass.
   */
  finished(): void {
    this.terminal.set(null);
    this.refusalState.set(null);
  }
}
