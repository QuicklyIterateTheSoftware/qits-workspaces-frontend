import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import { AgentSignIn } from './agent-sign-in';

/**
 * "Nobody is signed in", said plainly, with the sign-in terminal offered as the next step. The
 * Terminal tab draws the terminal once it is open.
 */
@Component({
  selector: 'app-sign-in-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton],
  template: `
    @if (signIn.refusal(); as refusal) {
      <div class="signed-out" role="alert">
        <p class="said">{{ refusal.message }}</p>
        <p class="note">
          The sign-in writes to the shared agent home, so completing it once signs every workspace
          on this platform in. The service starts the agent again on its own afterwards.
        </p>
        <qits-button variant="primary" size="sm" [busy]="signIn.busy()" (pressed)="press()">{{
          label()
        }}</qits-button>
      </div>
    }

    @if (signIn.problem(); as problem) {
      <p class="problem" role="alert">⚠ {{ problem }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .signed-out {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
      margin: 0.5rem 0;
      padding: 0.75rem;
      border: 1px solid #fcd34d;
      border-radius: 0.375rem;
      background: #fffbeb;
    }
    .said {
      margin: 0;
      color: #78350f;
      font-size: 0.9rem;
    }
    .note {
      margin: 0;
      color: #92400e;
      font-size: 0.85rem;
    }
    .problem {
      margin: 0.5rem 0 0;
      color: #b91c1c;
      font-size: 0.85rem;
    }
  `,
})
export class SignInNotice {
  protected readonly signIn = inject(AgentSignIn);

  /** Which workspace's container the terminal is opened in. */
  readonly workspaceRowId = input.required<number>();

  /** The terminal is open. */
  readonly opened = output<void>();

  /** A terminal already on screen is shown, not launched again: the volume needs one OAuth. */
  protected readonly label = computed(() =>
    this.signIn.commandId() ? 'Show the sign-in terminal' : 'Open the sign-in terminal',
  );

  protected async press(): Promise<void> {
    await this.signIn.open(this.workspaceRowId());
    if (this.signIn.commandId()) {
      this.opened.emit();
    }
  }
}
