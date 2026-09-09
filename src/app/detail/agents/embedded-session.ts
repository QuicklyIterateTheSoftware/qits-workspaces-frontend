import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { QitsButton } from '@qits/ui-components';
import type { AgentType } from '../../api/commands-api';
import { FileNavigation } from '../files/file-navigation';
import { AgentSession } from './agent-session';
import { SignInNotice } from './sign-in-notice';
import { TerminalView } from './terminal-view';

/**
 * The embedded session, drawn: one state per branch of the resolution, and a terminal for the two
 * that have one.
 *
 * The resolution itself lives in {@link ./agent-session#AgentSession}, because it outlives this
 * component — the socket must survive a tab switch, and a panel that owned it would drop the
 * conversation the moment somebody looked at Files. What is here is only what the branch looks like.
 *
 * **Nothing on this screen resumes by itself.** Branch 4 renders a choice and waits, and it waits
 * even when there is exactly one obvious thing to continue. The recorded session can be gone from the
 * agent's own state, and auto-resuming a vanished id exits instantly with "no conversation found" in
 * a loop nobody asked for.
 *
 * **A resumed session keeps its original harness**, so the picker is *shown* beside Resume and
 * *disabled* — the rule is easier to believe when you can see it refuse.
 */
@Component({
  selector: 'app-embedded-session',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton, SignInNotice, TerminalView],
  template: `
    @switch (branch().kind) {
      @case ('resolving') {
        <p class="note" role="status">Working out what this workspace's agent is doing…</p>
      }

      @case ('unavailable') {
        <p class="problem" role="alert">⚠ {{ message() }}</p>
      }

      @case ('deferred') {
        <div class="deferred">
          <p>
            This workspace's conversation is live in the <strong>Chat</strong> tab. Two attachments
            to one session is the collision session-pinning exists to prevent, so nothing is
            launched here.
          </p>
          <qits-button variant="secondary" size="sm" (pressed)="goToChat()">
            Open the conversation
          </qits-button>
        </div>
      }

      @case ('signin') {
        <div class="signin">
          <p class="note">
            This is the sign-in terminal you asked for, not a session. Complete the sign-in here — it
            writes to the shared agent home, so it signs in every workspace at once — and then start
            the session you wanted. Nothing is relaunched when this exits.
          </p>
          <app-terminal-view
            [frames]="session.frames()"
            [attached]="attached()"
            label="Agent sign-in terminal"
            (data)="session.send($event)"
            (resized)="session.resize($event.cols, $event.rows)"
          />
        </div>
      }

      @case ('attached') {
        <div class="attached">
          <p class="link" role="status">{{ linkLabel() }}</p>
          @if (session.link() === 'lost') {
            <qits-button variant="ghost" size="sm" (pressed)="session.rearm()">
              Try the connection again
            </qits-button>
          }
          <app-terminal-view
            [frames]="session.frames()"
            [attached]="attached()"
            (data)="session.send($event)"
            (resized)="session.resize($event.cols, $event.rows)"
          />
        </div>
      }

      @case ('idle') {
        <div class="idle">
          <p class="note">
            Nothing is running in this workspace. Sessions are not resumed automatically: the
            recorded one can be gone from the agent's own state, and continuing a vanished id exits
            at once with "no conversation found".
          </p>

          <div class="choice">
            <label class="picker">
              <span>Harness</span>
              <select
                [value]="chosen() ?? session.defaultAgent() ?? ''"
                (change)="chosen.set($any($event.target).value)"
              >
                @for (agent of harnesses(); track agent) {
                  <option [value]="agent">{{ agent.toLowerCase() }}</option>
                }
              </select>
            </label>
            <qits-button
              variant="primary"
              size="sm"
              [busy]="session.launching()"
              (pressed)="startFresh()"
            >
              Start a new session
            </qits-button>
          </div>

          @if (session.lastSession(); as last) {
            <div class="choice">
              <label class="picker">
                <span>Harness</span>
                <select disabled>
                  <option>the session's own</option>
                </select>
              </label>
              <qits-button
                variant="secondary"
                size="sm"
                [busy]="session.launching()"
                (pressed)="resumeLast(last.sessionId)"
              >
                Resume the last session
              </qits-button>
              @if (transcriptOf(last.transcriptPath); as path) {
                <button type="button" class="transcript" (click)="openTranscript(path)">
                  Open its transcript
                </button>
              } @else if (last.transcriptPath) {
                <span class="note">
                  Its transcript is at <code>{{ last.transcriptPath }}</code
                  >, outside this workspace's tree.
                </span>
              }
            </div>
          }

          <p class="note">
            Any earlier session can be continued from the list below — a resume keeps the harness it
            started with.
          </p>
        </div>
      }
    }

    <!--
      Outside the switch, and hidden only while the terminal it offers is the thing on screen: the
      refusal is true of every branch a launch can be attempted from, and it is what the idle
      choice's Start button will meet again until somebody signs in.
    -->
    @if (branch().kind !== 'signin') {
      <app-sign-in-notice [workspaceRowId]="workspaceRowId()" />
    }

    @if (session.problem(); as text) {
      <p class="problem" role="alert">
        ⚠ {{ text }}
        <button type="button" class="dismiss" (click)="session.clearProblem()">Dismiss</button>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .note {
      margin: 0 0 0.5rem;
      color: #6b7280;
      font-size: 0.85rem;
    }
    .problem {
      margin: 0.5rem 0 0;
      color: #b91c1c;
      font-size: 0.85rem;
    }
    .deferred {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      padding: 0.75rem;
      border: 1px solid #bfdbfe;
      border-radius: 0.375rem;
      background: #eff6ff;
    }
    .deferred p {
      margin: 0;
      flex: 1;
      min-width: 18rem;
      color: #1e3a8a;
      font-size: 0.9rem;
    }
    .choice {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }
    .picker {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: #4b5563;
      font-size: 0.85rem;
    }
    select {
      padding: 0.2rem 0.35rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      background: #fff;
      font: inherit;
      font-size: 0.85rem;
    }
    select:disabled {
      background: #f3f4f6;
      color: #9ca3af;
    }
    .link {
      margin: 0 0 0.35rem;
      color: #6b7280;
      font-size: 0.8rem;
    }
    .transcript,
    .dismiss {
      border: 0;
      background: none;
      color: #2563eb;
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
      text-decoration: underline;
    }
  `,
})
export class EmbeddedSession {
  protected readonly session = inject(AgentSession);
  private readonly nav = inject(FileNavigation);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Which workspace's container this session lives in.
   *
   * An input rather than a read off {@link AgentSession}: the resolution is pointed at a workspace by
   * the panel above, and a component that took the id from the service it drives would be reading its
   * own instruction back.
   */
  readonly workspaceRowId = input.required<number>();

  protected readonly branch = this.session.branch;

  /** The harness a *fresh* launch takes. Null means "whatever the container resolves as default". */
  protected readonly chosen = signal<AgentType | null>(null);

  protected readonly harnesses = computed<readonly AgentType[]>(
    () => this.session.available()?.agents ?? [],
  );

  protected readonly attached = computed(() => this.session.link() === 'open');

  protected readonly message = computed(() => {
    const branch = this.branch();
    return branch.kind === 'unavailable' ? branch.message : '';
  });

  protected readonly linkLabel = computed(() => {
    switch (this.session.link()) {
      case 'open':
        return 'Attached. Closing this tab detaches; it does not stop the agent.';
      case 'connecting':
        return 'Attaching to the session…';
      case 'reconnecting':
        return 'Reconnecting — the replay repaints the screen when it lands.';
      case 'lost':
        return 'The connection did not come back. The run may still be going.';
      default:
        return 'Detached. The session has ended, or it was never attached.';
    }
  });

  protected startFresh(): void {
    const chosen = this.chosen() ?? this.session.defaultAgent();
    void this.session.startFresh(chosen ?? undefined);
  }

  protected resumeLast(sessionId: string): void {
    void this.session.resume(sessionId);
  }

  /**
   * A transcript path the file viewer can actually open.
   *
   * `GET /files/content` reads anything **inside the workspace root**, tracked or not — but the
   * harness writes transcripts to a volume shared across workspaces, which is usually outside it. An
   * absolute path is therefore named rather than linked: a link that 404s is worse than a sentence
   * saying where the file is.
   */
  protected transcriptOf(path: string | undefined): string | null {
    return path && !path.startsWith('/') ? path : null;
  }

  protected openTranscript(path: string): void {
    this.nav.openAt(path);
  }

  /** The jump link. A tab is a query parameter, so this is a URL write like every other one. */
  protected goToChat(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: 'chat' },
      queryParamsHandling: 'merge',
    });
  }
}
