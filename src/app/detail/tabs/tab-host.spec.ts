import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TabHost } from './tab-host';
import { TabPanel } from './tab-panel';
import type { TabDef } from './tabs';

/**
 * A panel that remembers being built, which is the only way to tell "hidden" from "destroyed" from
 * the outside.
 */
@Component({
  selector: 'app-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="probe">{{ name() }}#{{ instance }}</span>`,
})
class Probe {
  static builds = 0;
  readonly name = input.required<string>();
  readonly instance = ++Probe.builds;
}

@Component({
  selector: 'app-probe-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Probe, TabHost, TabPanel],
  template: `
    <app-tab-host [tabs]="tabs()" [selected]="selected()" (selectTab)="selected.set($event)">
      @for (tab of tabs(); track tab.slug) {
        <ng-template [appTabPanel]="tab.slug">
          <app-probe [name]="tab.slug" />
        </ng-template>
      }
    </app-tab-host>
  `,
})
class ProbeHost {
  readonly tabs = signal<readonly TabDef[]>([
    { slug: 'chat', label: 'Chat', inUrl: true },
    { slug: 'files', label: 'Files', inUrl: true },
    {
      slug: 'agents',
      label: 'Agents',
      inUrl: true,
      dot: 'accent',
      dotTitle: 'The agent is working',
    },
  ]);
  readonly selected = signal('chat');
}

/**
 * The contract the rest of the page is built on, in four assertions.
 *
 * **Hidden panels stay mounted.** A chat socket, a framed application, an open file and every scroll
 * position survive a tab switch because the panel is hidden and never destroyed — and the cross-tab
 * "open this file at these lines" jump exists only because of it. Rebuilding a panel on return would
 * break all of that silently, which is why the probe counts constructions rather than looking for a
 * DOM node.
 *
 * **They mount on first selection and not before.** Rendering all four eagerly would keep the contract
 * and fire four panels' worth of requests on every page load, on a page where three of them may never
 * be opened.
 *
 * **Reordering moves the buttons and nothing else.** The strip renders the user's order and the panel
 * container renders the declaration order; moving a panel in the document would reload its iframe and
 * reset its scroll, which is the exact damage keep-mounted exists to prevent.
 */
describe('TabHost', () => {
  const build = async () => {
    const fixture = TestBed.createComponent(ProbeHost);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };

  const buttons = (fixture: { nativeElement: HTMLElement }): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.strip .tab'));

  const panels = (fixture: { nativeElement: HTMLElement }): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.panels .panel'));

  const probes = (fixture: { nativeElement: HTMLElement }): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.probe')).map(
      (node) => (node as HTMLElement).textContent ?? '',
    );

  beforeEach(() => {
    Probe.builds = 0;
    TestBed.configureTestingModule({});
  });

  it('mounts only the tab that is selected, and leaves the rest unbuilt', async () => {
    const fixture = await build();

    expect(probes(fixture)).toEqual(['chat#1']);
    expect(panels(fixture)).toHaveLength(3);
  });

  it('keeps a panel alive when its tab is hidden, and shows it again unchanged', async () => {
    const fixture = await build();
    const chat = probes(fixture)[0];

    buttons(fixture)[1].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(probes(fixture)).toEqual([chat, 'files#2']);
    expect(panels(fixture)[0].style.display).toBe('none');

    buttons(fixture)[0].click();
    await fixture.whenStable();
    fixture.detectChanges();

    // The same instance, not a rebuild of the same component.
    expect(probes(fixture)[0]).toBe(chat);
    expect(Probe.builds).toBe(2);
  });

  it('draws a label dot with the sentence that explains it', async () => {
    const fixture = await build();
    const dot = buttons(fixture)[2].querySelector('.dot') as HTMLElement;

    expect(dot.classList.contains('accent')).toBe(true);
    expect(dot.title).toBe('The agent is working');
  });

  it('reorders the buttons on a drag, and does not move or rebuild a single panel', async () => {
    const fixture = await build();
    buttons(fixture)[1].click();
    await fixture.whenStable();
    fixture.detectChanges();

    const beforeProbes = probes(fixture);
    const beforePanels = panels(fixture).map((panel) => panel.id);
    expect(beforePanels).toEqual(['panel-chat', 'panel-files', 'panel-agents']);

    const row = buttons(fixture);
    row[2].dispatchEvent(new Event('dragstart'));
    row[0].dispatchEvent(new Event('dragover'));
    row[0].dispatchEvent(new Event('drop'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(buttons(fixture).map((button) => button.id)).toEqual([
      'tab-agents',
      'tab-chat',
      'tab-files',
    ]);
    expect(panels(fixture).map((panel) => panel.id)).toEqual(beforePanels);
    expect(probes(fixture)).toEqual(beforeProbes);
  });

  it('pins a tab to the front of the row, ahead of the order', async () => {
    const fixture = await build();
    fixture.componentInstance.tabs.update((tabs) => [
      ...tabs,
      { slug: 'starting', label: 'Starting', inUrl: false, pinFront: true },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(buttons(fixture)[0].id).toBe('tab-starting');
  });

  it('drops a latch when the panel it belongs to goes away, so the next one starts fresh', async () => {
    const fixture = await build();
    fixture.componentInstance.tabs.update((tabs) => [
      { slug: 'starting', label: 'Starting', inUrl: false, pinFront: true },
      ...tabs,
    ]);
    fixture.componentInstance.selected.set('starting');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(probes(fixture)).toContain('starting#2');

    fixture.componentInstance.tabs.update((tabs) => tabs.filter((tab) => tab.slug !== 'starting'));
    fixture.componentInstance.selected.set('chat');
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.componentInstance.tabs.update((tabs) => [
      { slug: 'starting', label: 'Starting', inUrl: false, pinFront: true },
      ...tabs,
    ]);
    fixture.componentInstance.selected.set('starting');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(probes(fixture)).toContain('starting#3');
  });
});
