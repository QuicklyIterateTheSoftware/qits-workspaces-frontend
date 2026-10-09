import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { TabPanel } from './tab-panel';
import type { TabDef } from './tabs';

/**
 * The tab row, and the contract the rest of the page is built on.
 *
 * **Hidden tabs stay mounted.** This is not an optimisation. The chat's websocket, the framed app's
 * iframe, the file browser's open file and every scroll position survive a tab switch because the
 * panels are merely hidden, never destroyed — and the cross-tab "open this file at these lines" jump
 * exists only because of it. Angular has no keep-alive, so it is built out of two pieces:
 *
 * - **`@if (latched)` inside a `[style.display]` wrapper.** `latched` flips true the first time a tab
 *   is selected and never flips back, so a panel is created once, on first selection, and then only
 *   hidden. That is exactly "expensive panels initialise on first selection, then persist", said in
 *   the framework. Rendering all five eagerly with `display` alone would keep the contract and fire
 *   five loads on page open; `@if (active)` would fire one load and break the contract.
 * - **Two loops with two orders.** The strip renders {@link ordered}, which is the user's; the panel
 *   container renders the templates in declaration order, which never changes. Moving a panel in the
 *   document would reload its iframe and reset its scroll — the very thing keep-mounted prevents — so
 *   dragging a tab must move the button and nothing else. One sentence of Angular, and it is what
 *   makes a reorder free.
 *
 * **A latch is dropped when its panel goes away.** The transient process tab unmounts when its
 * operation ends; if its latch survived, the next container start would render a panel already
 * holding the last one's log. Everything else is declared unconditionally and never prunes.
 *
 * **Panels are not told whether they are visible here.** The page owns `selected` and passes each
 * panel its own `[visible]` input, because the gate that matters is per-panel policy — Chat and
 * Agents keep working while hidden (a detached socket stops replaying correctly), and everything else
 * stops refetching and does one catch-up read on becoming visible. A host that decided that centrally
 * would be deciding it wrong for two panels.
 *
 * Reordering is **in-session only**: a local signal that dies with the page. Per-browser persistence
 * costs a stored-order migration every time a tab is added or renamed, on a row of four.
 */
@Component({
  selector: 'app-tab-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <div class="strip" role="tablist" [attr.aria-label]="label()">
      @for (tab of ordered(); track tab.slug) {
        <button
          type="button"
          role="tab"
          class="tab"
          [class.active]="tab.slug === selected()"
          [class.pinned]="tab.pinFront"
          [class.dragging]="tab.slug === dragging()"
          [id]="'tab-' + tab.slug"
          [attr.aria-selected]="tab.slug === selected()"
          [attr.aria-controls]="'panel-' + tab.slug"
          [attr.tabindex]="tab.slug === selected() ? 0 : -1"
          [attr.draggable]="tab.pinFront ? null : 'true'"
          (click)="selectTab.emit(tab.slug)"
          (keydown)="onKey($event, tab)"
          (dragstart)="dragging.set(tab.slug)"
          (dragend)="dragging.set(null)"
          (dragover)="allowDrop($event, tab)"
          (drop)="dropOn($event, tab)"
        >
          <span>{{ tab.label }}</span>
          @if (tab.dot) {
            <span
              class="dot"
              [class.accent]="tab.dot === 'accent'"
              [class.success]="tab.dot === 'success'"
              [class.warning]="tab.dot === 'warning'"
              [title]="tab.dotTitle ?? ''"
              aria-hidden="true"
            ></span>
            <span class="sr">{{ tab.dotTitle }}</span>
          }
        </button>
      }
    </div>

    <div class="panels">
      @for (panel of panels(); track panel.appTabPanel()) {
        <div
          class="panel"
          role="tabpanel"
          [id]="'panel-' + panel.appTabPanel()"
          [attr.aria-labelledby]="'tab-' + panel.appTabPanel()"
          [style.display]="panel.appTabPanel() === selected() ? null : 'none'"
        >
          @if (isLatched(panel.appTabPanel())) {
            <ng-container [ngTemplateOutlet]="panel.template" />
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .strip {
      display: flex;
      gap: 0.25rem;
      overflow-x: auto;
      border-bottom: 1px solid #e5e7eb;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex: 0 0 auto;
      padding: 0.5rem 0.85rem;
      border: 0;
      border-bottom: 2px solid transparent;
      background: none;
      color: #374151;
      font: inherit;
      font-size: 0.9rem;
      cursor: pointer;
    }
    .tab:hover {
      background: #f9fafb;
    }
    .tab.active {
      color: #111827;
      border-bottom-color: #2563eb;
      font-weight: 600;
    }
    .tab.pinned {
      color: #1d4ed8;
      cursor: default;
    }
    .tab.dragging {
      opacity: 0.5;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #9ca3af;
    }
    .dot.accent {
      background: #2563eb;
    }
    .dot.success {
      background: #16a34a;
    }
    .dot.warning {
      background: #d97706;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .panels {
      padding-top: 0.75rem;
    }
  `,
})
export class TabHost {
  /** Every tab to draw, transient included. The page adds and removes the transient one. */
  readonly tabs = input.required<readonly TabDef[]>();

  /** Which tab is showing. The page owns this, because half of it is the URL. */
  readonly selected = input.required<string>();

  /** What the row is called, for a screen reader. */
  readonly label = input('Workspace');

  /** A tab was chosen. The page decides whether that is a navigation. */
  readonly selectTab = output<string>();

  protected readonly panels = contentChildren(TabPanel);

  protected readonly dragging = signal<string | null>(null);

  /** Every slug that has ever been selected while its panel existed. Only grows, and only prunes. */
  private readonly latched = signal<ReadonlySet<string>>(new Set());

  private readonly order = signal<readonly string[]>([]);

  constructor() {
    effect(() => {
      const selected = this.selected();
      const present = new Set(
        this.panels()
          .map((panel) => panel.appTabPanel())
          .filter((slug) => slug !== ''),
      );
      this.latched.update((latched) => {
        const next = new Set([...latched].filter((slug) => present.has(slug)));
        if (present.has(selected)) {
          next.add(selected);
        }
        return sameSet(next, latched) ? latched : next;
      });
    });
  }

  /**
   * The strip's order: pinned tabs first, then the user's, then anything the order has never heard
   * of.
   *
   * The last clause is what makes a tab added later append rather than disappear — an order that does
   * not mention a tab must degrade, not break.
   */
  protected readonly ordered = computed<readonly TabDef[]>(() => {
    const tabs = this.tabs();
    const pinned = tabs.filter((tab) => tab.pinFront);
    const rest = tabs.filter((tab) => !tab.pinFront);
    const order = this.order();
    if (order.length === 0) {
      return [...pinned, ...rest];
    }
    const ranked = rest.map((tab, index) => {
      const at = order.indexOf(tab.slug);
      return { tab, rank: at === -1 ? order.length + index : at };
    });
    ranked.sort((left, right) => left.rank - right.rank);
    return [...pinned, ...ranked.map((entry) => entry.tab)];
  });

  protected isLatched(slug: string): boolean {
    return this.latched().has(slug);
  }

  protected allowDrop(event: DragEvent, tab: TabDef): void {
    if (this.dragging() && !tab.pinFront) {
      // Without this the drop never fires: the default action for a dragover is "no drop here".
      event.preventDefault();
    }
  }

  protected dropOn(event: DragEvent, tab: TabDef): void {
    event.preventDefault();
    const dragged = this.dragging();
    this.dragging.set(null);
    if (!dragged || dragged === tab.slug || tab.pinFront) {
      return;
    }
    const current = this.ordered()
      .filter((entry) => !entry.pinFront)
      .map((entry) => entry.slug);
    const from = current.indexOf(dragged);
    const to = current.indexOf(tab.slug);
    if (from < 0 || to < 0) {
      return;
    }
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    this.order.set(next);
  }

  /** Arrow keys walk the row, as a tablist is expected to. */
  protected onKey(event: KeyboardEvent, tab: TabDef): void {
    const tabs = this.ordered();
    const at = tabs.indexOf(tab);
    let next = -1;
    if (event.key === 'ArrowRight') {
      next = (at + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft') {
      next = (at - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = tabs.length - 1;
    }
    if (next >= 0) {
      event.preventDefault();
      this.selectTab.emit(tabs[next].slug);
    }
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
