/**
 * What a tab is, and which tabs there are.
 *
 * Four tabs plus one transient, which is the answer to "ten is a lot". Sketch is gone (it does not
 * survive a reload and pasting a screenshot covers the same delivery path), Bootstrap is a section
 * inside Actions (its entire per-workspace content is three lines of status), and Telemetry is phase
 * two (real, cheap, and the one surface with no live hint to refresh it). Services and Web view are
 * gone too: the workspace container no longer supervises dev servers, so there is nothing left for
 * either tab to show.
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
 * The four durable tabs, in their default order.
 *
 * The order is what a fresh page opens with; dragging rewrites it for the session and nothing else.
 * Per-browser persistence was dropped deliberately: it buys per-device ergonomics on a row of four
 * and costs a stored-order migration every time a tab is added or renamed — which this
 * reimplementation is doing on day one. The asymmetry is worth keeping either way: tab order is
 * device ergonomics, and the prompt draft is work product and lives on the server.
 */
export const DURABLE_TABS: readonly TabDef[] = [
  { slug: 'chat', label: 'Chat', inUrl: true },
  { slug: 'files', label: 'Files', inUrl: true },
  { slug: 'actions', label: 'Actions', inUrl: true },
  { slug: 'agents', label: 'Agents', inUrl: true },
];

/** The default selection: the first durable tab. A bare URL means "no tab pinned", not "chat". */
export const DEFAULT_TAB = DURABLE_TABS[0].slug;

/** Whether a slug names a durable tab. An unknown slug in the URL is normalised away, not obeyed. */
export function isDurableTab(slug: string | null): boolean {
  return DURABLE_TABS.some((tab) => tab.slug === slug);
}
