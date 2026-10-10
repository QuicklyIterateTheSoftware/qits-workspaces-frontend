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
import { QitsButton } from '@qits/ui-components';
import { CommandsApi, type CommandDto } from '../../api/commands-api';
import type { AgentDeliveryDto } from '../../api/dto';
import { WEB_SOCKET_FACTORY } from '../../api/web-socket';
import { WorkspaceCommands } from '../../api/workspace-commands';
import { WorkspaceDaemonApi } from '../../api/workspace-daemon-api';
import { Async } from '../../ui/async';
import { describeError } from '../../ui/loadable';
import { ChatSocket, type ChatLink } from './chat-socket';
import { EMPTY_CONVERSATION, buildConversation } from './chat-model';
import { Conversation } from './conversation';
import { PromptPanel } from './prompt-panel';

/**
 * One agent's conversation: watch it work, or say the next thing.
 *
 * **On first open this panel reads `1`, plus one socket while the agent's chat runs.** The read is
 * the container's command list, a shared entry the Terminal tab reads too.
 *
 * The agent's harness is one command, named by the daemon's worktree read (`commandId`). While that
 * command is a running `CHAT`, this tab attaches to its socket and a typed turn goes down it. When it
 * is not — the agent yielded, is queued, or runs in a terminal — the prompt panel sends the turn
 * through the service's delivery door, which resumes the agent to hear it (qits-1152).
 *
 * The live tail covers the main session only; sub-agent side-chains join when the run ends, and the
 * header says so while the run is live.
 */
@Component({
  selector: 'app-chat-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Conversation, PromptPanel, QitsButton],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.css',
})
export class ChatPanel {
  private readonly commands = inject(WorkspaceCommands);
  private readonly api = inject(CommandsApi);
  private readonly daemon = inject(WorkspaceDaemonApi);
  private readonly openSocket = inject(WEB_SOCKET_FACTORY);

  /** The agent's workspace. 0 while the agent is queued and has none. */
  readonly workspaceRowId = input.required<number>();

  /** The agent this conversation is with. */
  readonly agentId = input.required<string>();

  /** The agent's work item, which the delivery door is keyed by. */
  readonly workId = input.required<string>();

  /** The agent's harness command, as its worktree reports it. Null while the daemon knows none. */
  readonly commandId = input<string | null>(null);

  /** What the work is about, handed to the prompt rewrite. */
  readonly preamble = input<string | null>(null);

  protected readonly commandsState = this.commands.commands;

  /** What the last turn sent from the prompt panel became, in words. */
  protected readonly lastSent = signal<string | null>(null);

  protected readonly terminating = signal(false);
  protected readonly terminateProblem = signal<string | null>(null);

  /**
   * The attachment, as a signal so the panel's own state composes out of the socket's rather than
   * being copied into it by an effect. One source of truth, and a detach is one `set`.
   */
  private readonly socket = signal<ChatSocket | null>(null);
  private readonly attached = signal<string | null>(null);

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      untracked(() => this.commands.use(workspaceRowId));
    });

    effect(() => {
      const command = this.session();
      const workspaceRowId = this.workspaceRowId();
      untracked(() => this.attach(workspaceRowId, command?.id ?? null));
    });

    inject(DestroyRef).onDestroy(() => this.detach());
  }

  // ---- which conversation, if any ----------------------------------------------------------------

  /** The agent's harness command, once the command list has it. */
  private readonly harness = computed<CommandDto | null>(() => {
    const id = this.commandId();
    const state = this.commandsState();
    if (!id || state.kind !== 'ready') {
      return null;
    }
    return state.value.find((command) => command.id === id) ?? null;
  });

  /** The agent's chat while it runs; null when there is no live chat to attach to. */
  protected readonly session = computed<CommandDto | null>(() => {
    const command = this.harness();
    return command && command.kind === 'CHAT' && command.status === 'RUNNING' ? command : null;
  });

  /** The agent runs its harness in a terminal: its screen is on the Terminal tab. */
  protected readonly inTerminal = computed(() => {
    const command = this.harness();
    return command !== null && command.kind === 'TERMINAL' && command.status === 'RUNNING';
  });

  /** Whether the prompt panel can be drawn: the list answered, or there is no container to ask. */
  protected readonly composable = computed(
    () => this.workspaceRowId() <= 0 || this.commandsState().kind !== 'loading',
  );

  private readonly lines = computed<readonly string[]>(() => this.socket()?.lines() ?? []);

  protected readonly conversation = computed(() => {
    const lines = this.lines();
    return lines.length === 0 ? EMPTY_CONVERSATION : buildConversation(lines);
  });

  protected readonly status = computed<ChatLink>(() => this.socket()?.status() ?? 'closed');

  protected readonly pending = computed(() => this.socket()?.queued() ?? 0);

  /** Whether the run is still going, as far as this panel can tell. */
  protected readonly live = computed(() => this.session() !== null && !this.conversation().closed);

  protected readonly draft = signal('');

  protected readonly canSend = computed(() => this.draft().trim().length > 0 && this.live());

  // ---- what the panel does ------------------------------------------------------------------------

  /** A turn the prompt panel sent through the delivery door. */
  protected onSent(delivery: AgentDeliveryDto): void {
    this.lastSent.set(deliveryNote(delivery));
    void this.commands.refresh();
  }

  protected send(): void {
    const text = this.draft().trim();
    const socket = this.socket();
    if (!text || !socket) {
      return;
    }
    socket.send(text);
    // Never an optimistic bubble: the turn appears when the server echoes it, which is what makes
    // the live view and a later replay agree.
    this.draft.set('');
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.send();
    }
  }

  /** End the run. Invalidates on settled, not on success — a failed terminate still refetches. */
  protected async terminate(): Promise<void> {
    const command = this.session();
    if (!command || this.terminating()) {
      return;
    }
    this.terminating.set(true);
    this.terminateProblem.set(null);
    try {
      await this.api.terminate(this.workspaceRowId(), command.id);
    } catch (error) {
      this.terminateProblem.set(`The session did not stop — ${describeError(error)}.`);
    } finally {
      this.terminating.set(false);
      await this.commands.refresh();
    }
  }

  protected retry(): void {
    void this.commands.refresh();
  }

  // ---- the socket ---------------------------------------------------------------------------------

  /**
   * Attach to one command's conversation, or to none.
   *
   * Keyed by command id: a relaunch is a new id, and reusing a socket bound to a dead process is the
   * bug keying exists to prevent. Detaching only closes this end — the agent keeps running, which is
   * the whole reason switching tabs is free.
   */
  private attach(workspaceRowId: number, commandId: string | null): void {
    if (this.attached() === commandId) {
      return;
    }
    this.detach();
    this.attached.set(commandId);
    if (!commandId || workspaceRowId <= 0) {
      return;
    }
    const socket = new ChatSocket(
      this.daemon.socketUrl(workspaceRowId, `/chat/commands/${encodeURIComponent(commandId)}`),
      this.openSocket,
    );
    this.socket.set(socket);
    socket.connect();
  }

  private detach(): void {
    this.socket()?.close();
    this.socket.set(null);
    this.attached.set(null);
  }
}

/** What became of a delivered turn, in words. */
export function deliveryNote(delivery: AgentDeliveryDto): string {
  if (delivery.resumed) {
    return 'Sent. The agent resumes to hear it.';
  }
  if (delivery.launched) {
    return 'Sent. The agent hears it as its first turn, once it starts.';
  }
  if (delivery.delivered) {
    return 'Sent. The agent hears it at its next turn boundary.';
  }
  return (
    delivery.detail?.trim() || 'The service took the message but did not say what became of it.'
  );
}
