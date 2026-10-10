import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { AgentsApi } from '../../api/agents-api';
import type { CommandDto } from '../../api/commands-api';
import type { AgentHarness } from '../../api/dto';
import { WEB_SOCKET_FACTORY } from '../../api/web-socket';
import { WorkspaceCommands } from '../../api/workspace-commands';
import { WorkspaceDaemonApi } from '../../api/workspace-daemon-api';
import { Async } from '../../ui/async';
import { AgentSignIn, signedOutHarness } from '../agents/agent-sign-in';
import { PluginsSection } from '../agents/plugins-section';
import { SignInNotice } from '../agents/sign-in-notice';
import { EMPTY_TERMINAL_FRAMES, TerminalSocket } from '../agents/terminal-socket';
import { TerminalView } from '../agents/terminal-view';

/** What the terminal shows, if anything. */
export type TerminalTarget =
  | { readonly kind: 'signin'; readonly commandId: string }
  | { readonly kind: 'agent'; readonly commandId: string }
  | { readonly kind: 'chat' }
  | { readonly kind: 'none' };

/**
 * The Terminal tab: the agent's harness when it runs interactive, the sign-in terminal when
 * somebody opened one, and the plugin store.
 *
 * A terminal here is a command's PTY socket (`WS /terminal/commands/{id}`). The browser starts no
 * harness (qits-1152): the service starts each agent, by default in a terminal, so this tab is an
 * agent's live view. For an agent that runs as a chat it says where its conversation is instead.
 *
 * The socket stays attached while the tab is hidden, so the screen survives a tab switch. Closing
 * detaches; it never stops the process.
 */
@Component({
  selector: 'app-terminal-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, PluginsSection, SignInNotice, TerminalView],
  template: `
    @if (workspaceRowId() <= 0) {
      <p class="note">This agent is queued and has no workspace yet, so there is no terminal.</p>
    } @else {
      <app-async
        [state]="commandsState()"
        loadingLabel="Looking for the agent's harness"
        errorLabel="Could not reach the container"
        (retry)="retry()"
      />

      <app-sign-in-notice [workspaceRowId]="workspaceRowId()" />

      @switch (target().kind) {
        @case ('signin') {
          <p class="note">
            The sign-in terminal. Complete the sign-in, then close it with its own exit.
          </p>
          <app-terminal-view
            [frames]="frames()"
            [attached]="attached()"
            label="Agent sign-in terminal"
            (data)="send($event)"
            (resized)="resize($event.cols, $event.rows)"
          />
        }
        @case ('agent') {
          <app-terminal-view
            [frames]="frames()"
            [attached]="attached()"
            label="Agent terminal"
            (data)="send($event)"
            (resized)="resize($event.cols, $event.rows)"
          />
          @if (link() === 'lost') {
            <button type="button" class="rearm" (click)="rearm()">Try to attach again</button>
          }
        }
        @case ('chat') {
          <p class="note">
            This agent runs as a chat, so it has no terminal. Its conversation is on the Chat tab.
          </p>
        }
        @default {
          @if (commandsState().kind === 'ready') {
            <p class="note">
              The agent's harness is not running. The service starts it again when the agent gets
              its turn.
            </p>
          }
        }
      }

      <section class="block" aria-label="Agent plugins">
        <h3>Plugins</h3>
        <app-plugins-section [workspaceRowId]="workspaceRowId()" [agentId]="agentId()" />
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .note {
      margin: 0.5rem 0;
      color: #4b5563;
      font-size: 0.9rem;
    }
    .block {
      margin-top: 1.25rem;
    }
    .block h3 {
      margin: 0 0 0.5rem;
      font-size: 1rem;
    }
    .rearm {
      margin-top: 0.5rem;
      border: 0;
      background: none;
      color: #2563eb;
      font: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
  `,
})
export class TerminalPanel {
  private readonly commands = inject(WorkspaceCommands);
  private readonly agentsApi = inject(AgentsApi);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly openSocket = inject(WEB_SOCKET_FACTORY);
  private readonly document = inject(DOCUMENT);
  private readonly signIn = inject(AgentSignIn);

  /** The agent's workspace. 0 while the agent is queued. */
  readonly workspaceRowId = input.required<number>();

  /** The agent this tab belongs to. */
  readonly agentId = input.required<string>();

  /** The agent's harness command, as its worktree reports it. */
  readonly commandId = input<string | null>(null);

  /** The agent's harness, so the sign-in notice names the one that matters. */
  readonly harness = input<AgentHarness | null>(null);

  protected readonly commandsState = this.commands.commands;

  private readonly socket = signal<TerminalSocket | null>(null);
  private socketFor: string | null = null;
  private reportedFor = 0;

  protected readonly frames = computed(() => this.socket()?.frames() ?? EMPTY_TERMINAL_FRAMES);
  protected readonly link = computed(() => this.socket()?.status() ?? 'disconnected');
  protected readonly attached = computed(() => this.link() === 'open');

  private readonly commandList = computed<readonly CommandDto[]>(() => {
    const state = this.commandsState();
    return state.kind === 'ready' ? state.value : [];
  });

  /** What to draw. A sign-in terminal somebody opened comes first: the agent cannot start without it. */
  readonly target = computed<TerminalTarget>(() => {
    const signIn = this.signIn.visibleCommandId();
    if (signIn) {
      const command = this.commandList().find((entry) => entry.id === signIn);
      if (!command || command.status === 'RUNNING') {
        return { kind: 'signin', commandId: signIn };
      }
    }
    const id = this.commandId();
    const harness = id ? this.commandList().find((entry) => entry.id === id) : undefined;
    if (!harness || harness.status !== 'RUNNING') {
      return { kind: 'none' };
    }
    return harness.kind === 'TERMINAL'
      ? { kind: 'agent', commandId: harness.id }
      : { kind: 'chat' };
  });

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      untracked(() => {
        this.commands.use(workspaceRowId);
        if (workspaceRowId !== this.reportedFor) {
          this.reportedFor = workspaceRowId;
          this.signIn.reset();
          void this.readHarnessReport(workspaceRowId);
        }
      });
    });

    // A sign-in terminal that has exited is let go of, notice and all.
    effect(() => {
      const signIn = this.signIn.commandId();
      const command = signIn ? this.commandList().find((entry) => entry.id === signIn) : undefined;
      if (command && command.status !== 'RUNNING') {
        untracked(() => this.signIn.finished());
      }
    });

    effect(() => {
      const target = this.target();
      const workspaceRowId = this.workspaceRowId();
      const wanted = target.kind === 'signin' || target.kind === 'agent' ? target.commandId : null;
      untracked(() => this.attach(workspaceRowId, wanted));
    });

    inject(DestroyRef).onDestroy(() => this.detach());
  }

  protected send(data: string): void {
    this.socket()?.send(data);
  }

  protected resize(cols: number, rows: number): void {
    this.socket()?.resize(cols, rows);
  }

  protected rearm(): void {
    this.socket()?.rearm();
  }

  protected retry(): void {
    void this.commands.refresh();
  }

  /** Whether anybody has signed the harness in. A failed read costs the notice and nothing else. */
  private async readHarnessReport(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    try {
      const available = await this.agentsApi.available(workspaceRowId);
      if (this.workspaceRowId() === workspaceRowId) {
        this.signIn.report(signedOutHarness(available.capabilities ?? [], this.harness()));
      }
    } catch {
      // No report, no notice.
    }
  }

  /** One socket, keyed by command id: a new command is a new socket. */
  private attach(workspaceRowId: number, commandId: string | null): void {
    if (commandId === this.socketFor) {
      return;
    }
    this.detach();
    if (!commandId || workspaceRowId <= 0) {
      return;
    }
    const socket = new TerminalSocket(
      this.daemon.socketUrl(workspaceRowId, `/terminal/commands/${encodeURIComponent(commandId)}`),
      this.openSocket,
      this.document,
    );
    this.socketFor = commandId;
    this.socket.set(socket);
    socket.connect();
  }

  private detach(): void {
    this.socket()?.close();
    this.socket.set(null);
    this.socketFor = null;
  }
}
