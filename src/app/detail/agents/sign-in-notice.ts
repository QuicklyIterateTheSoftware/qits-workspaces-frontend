import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import { AgentSignIn } from './agent-sign-in';

/**
 * "Nobody is signed in", said plainly, with the sign-in terminal offered as the next step.
 *
 * **The point is the press.** The refusal and the door are two different things and this draws them
 * as two: a sentence naming the harness nobody has signed in, and a button that opens the terminal
 * where somebody can. What it replaces did neither — the launch quietly *became* the terminal and the
 * caller attached to it, so the only way to find out you had not started a session was to look at
 * what was on the screen and recognise a login prompt.
 *
 * Rendered by both surfaces that launch, because both meet the same wall: one sign-in serves the
 * whole shared credential volume, so being signed out is a fact about the container rather than about
 * the tab you pressed in.
 *
 * The terminal itself is the Agents tab's, which owns this page's one PTY. So the press has two
 * halves — open the command, then show where it is — and the second half is the caller's: the Agents
 * tab is already there, and the Chat tab jumps. {@link opened} is that seam.
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
          The sign-in writes to the shared agent home, so completing it once signs every workspace on
          this platform in. Nothing is relaunched when it closes — start the session again yourself,
          so a sign-in that did not take cannot become a launch loop.
        </p>
        <qits-button
          variant="primary"
          size="sm"
          [busy]="signIn.busy()"
          (pressed)="press()"
          >{{ label() }}</qits-button
        >
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

  /**
   * The terminal is open, or already was — go and show it.
   *
   * Emitted after the launch has answered, never before: a jump to a tab that has nothing to render
   * yet is the same "something happened, somewhere" the substitution used to be.
   */
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
