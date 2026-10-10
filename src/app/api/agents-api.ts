import { Injectable, inject } from '@angular/core';
import type { AgentType } from './commands-api';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's container-wide coding-agent surface, written by hand from
 * `qits-workspace-daemon/docs/openapi.yml`: the harnesses and their sign-in state, and the plugin
 * store. No agent owns these; the Terminal tab reads them for the agent it shows.
 */

/** What one harness in this image reports. Only the fields this app reads are typed. */
export interface HarnessCapabilitiesDto {
  readonly harness: AgentType;
  /** Whether anybody is signed in on the shared credential volume. A display value, never a gate. */
  readonly authenticated: boolean;
  /** Where to sign in, when nobody has. */
  readonly authDetail?: string;
}

/** The harnesses this container can launch, the default, and what each reports. */
export interface AvailableAgentsDto {
  readonly agents: readonly AgentType[];
  readonly defaultAgent: AgentType;
  /** Empty until the start-up probe lands. */
  readonly capabilities?: readonly HarnessCapabilitiesDto[];
}

/**
 * One plugin the shared credential volume records.
 *
 * `pluginId` is the **marketplace-qualified** form (`<id>@claude-plugins-official`), as the volume
 * writes it. The install verb takes the **bare** id and appends the suffix itself, so the qualified
 * form is refused there — see {@link barePluginId}.
 *
 * `enabled: false` is installed-but-switched-off, which is distinct from absent and is drawn as such.
 */
export interface InstalledPluginDto {
  readonly pluginId: string;
  readonly enabled: boolean;
}

interface PluginListResponse {
  readonly installed: readonly InstalledPluginDto[];
}

/**
 * What the install path will accept: the bare id, lowercase, dashes, up to 64 characters.
 *
 * The daemon pattern-matches this before the value reaches a shell, because it crosses from an
 * untrusted caller into an argv. This client checks the same shape first — not as a second line of
 * defence, but so a malformed id is a sentence here rather than a 400 from a request that should
 * never have left.
 */
const BARE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The marketplace the daemon installs from, and the suffix it appends to a bare id. */
export const PLUGIN_MARKETPLACE = 'claude-plugins-official';

/** Strip the marketplace suffix a listing reports, leaving the id the install verb takes. */
export function barePluginId(pluginId: string): string {
  const at = pluginId.indexOf('@');
  return at === -1 ? pluginId : pluginId.slice(0, at);
}

@Injectable({ providedIn: 'root' })
export class AgentsApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * The harnesses and the resolved default.
   *
   * Fetched once per page: it does not change under a running container. Its `capabilities` say
   * whether anybody has signed each harness in.
   */
  async available(workspaceRowId: number): Promise<AvailableAgentsDto> {
    return this.daemon.get<AvailableAgentsDto>(workspaceRowId, '/agents/available');
  }

  /**
   * What is installed on the shared credential volume.
   *
   * Read from the volume's `settings.json` rather than by shelling the CLI, so a volume with nothing
   * ever installed answers an empty list rather than an error. **The store is global to the shared
   * agent home**, so this answer is the same in every workspace — which is why the panel says so.
   */
  async plugins(workspaceRowId: number): Promise<readonly InstalledPluginDto[]> {
    const answer = await this.daemon.get<PluginListResponse>(workspaceRowId, '/agent-plugins');
    return answer.installed ?? [];
  }

  /**
   * Install one plugin, and answer the **refreshed installed set**.
   *
   * The response is the same envelope the listing uses, deliberately, so a client needs no follow-up
   * read to see the result of what it just did — and this one does not make one.
   *
   * `pluginId` may arrive in either form; the qualified suffix is stripped here, because the daemon
   * appends it and refuses the qualified form. Claude Code only: asking under another harness is a
   * 400 in the daemon's own words, which the caller renders.
   */
  async install(workspaceRowId: number, pluginId: string): Promise<readonly InstalledPluginDto[]> {
    const bare = barePluginId(pluginId);
    if (!BARE_PLUGIN_ID.test(bare)) {
      throw new Error(`“${pluginId}” is not a plugin id this marketplace can name.`);
    }
    const answer = await this.daemon.post<PluginListResponse>(
      workspaceRowId,
      `/agent-plugins/${encodeURIComponent(bare)}/install`,
    );
    return answer.installed ?? [];
  }
}
