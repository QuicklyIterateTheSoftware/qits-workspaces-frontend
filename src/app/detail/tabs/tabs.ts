/**
 * What a tab is, and which tabs an agent page has: Chat, Files and Terminal (qits-1152, D12). The
 * Actions tab and the bootstrap chain are gone; so are the editor and the Agents tab, whose terminal
 * is now the Terminal tab.
 */

/** How loud a tab's label dot is. */
export type TabDot = 'accent' | 'success' | 'warning';

/** One tab in the row. */
export interface TabDef {
  /** Identity, and the value written to `?tab=` when {@link inUrl} is true. */
  readonly slug: string;
  /** What the button says. */
  readonly label: string;
  /**
   * Whether the tab is nameable in the URL.
   *
   * Only the transient process tab says false. It unmounts when its process ends, so a link to it
   * would land nowhere — and a link is the whole reason the others are in the URL.
   */
  readonly inUrl: boolean;
  /**
   * Whether this tab is pinned ahead of the row, outside the user's ordering.
   *
   * Exactly one tab uses it, and it is a slot rather than a setting: the transient tab appears at
   * the front, takes the selection, and goes away again.
   */
  readonly pinFront?: boolean;
  /** A status dot on the label, with the sentence explaining it. Null draws nothing. */
  readonly dot?: TabDot | null;
  /** What the dot means, on hover and to a screen reader. */
  readonly dotTitle?: string;
}

/** The transient technical-process tab's slug. Not a URL value — see {@link TabDef.inUrl}. */
export const STARTING_SLUG = 'starting';

/**
 * The durable tabs, in their default order. Dragging rewrites the order for the session only: tab
 * order is device ergonomics, while the prompt draft is work product and lives on the server.
 */
export const DURABLE_TABS: readonly TabDef[] = [
  { slug: 'chat', label: 'Chat', inUrl: true },
  { slug: 'files', label: 'Files', inUrl: true },
  { slug: 'terminal', label: 'Terminal', inUrl: true },
];

/** Whether a slug names a durable tab. An unknown slug in the URL is normalised away, not obeyed. */
export function isDurableTab(slug: string | null): boolean {
  return DURABLE_TABS.some((tab) => tab.slug === slug);
}
