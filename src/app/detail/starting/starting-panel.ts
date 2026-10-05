import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { HINT_REMOTE_AUTH } from '../../api/dto';
import { ProcessLog, type ProcessSegment } from './process-log';

/** The segment a runner-placed start waits in before its container is launched. */
export const QUEUED_SEGMENT = 'queued';

/**
 * The transient tab: what a long operation against this workspace is doing, while it does it.
 *
 * A container start is the canonical case. The log arrives as a stack of named segments, each an
 * expander with a status badge, and three rules make it readable rather than a firehose:
 *
 * - **The running segment is open and a settled one collapses to its status line**, so the thing
 *   happening now is the thing you are reading.
 * - **A manual toggle overrides that for that segment, permanently.** Someone who opened a finished
 *   segment to read it is not asking to have it closed again a second later by the next frame.
 * - **The open body follows its newest line.**
 *
 * A failed segment may carry a classification and the target it applies to. The one documented value
 * is `remote-auth`, and its target names the repository to sign into — **for a submodule child that
 * is not the root repository**, so the sentence quotes the target it was given rather than the
 * workspace's own repository.
 *
 * **A runner-placed start opens with a `queued` segment**: the workspace waits for a slot on its
 * runner, or for any runner, before `container` begins. Its key says nothing to a reader, so the
 * head reads the service's own words instead — the segment's newest line, "waiting for a slot on
 * <runner>" — and its badge says `waiting` rather than `running`, because nothing is running yet.
 */
@Component({
  selector: 'app-starting-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ProcessLog],
  template: `
    <p class="lede">
      @switch (log.outcome()) {
        @case ('running') {
          Working on this workspace. You can switch tabs; this keeps running.
        }
        @case ('ok') {
          Finished. This tab closes itself in a moment.
        }
        @case ('failed') {
          Finished with a failure. This tab closes itself in a moment.
        }
        @case ('expired') {
          The log stream ended before the process finished (it may have expired).
        }
      }
    </p>

    @if (log.segments().length === 0 && log.outcome() === 'running') {
      <p class="waiting">Waiting for the first line…</p>
    }

    <ol class="segments">
      @for (segment of log.segments(); track segment.name) {
        <li class="segment" [class.open]="isOpen(segment)">
          <button
            type="button"
            class="head"
            [attr.aria-expanded]="isOpen(segment)"
            (click)="toggle(segment)"
          >
            <span class="chevron" aria-hidden="true"></span>
            <span class="name">{{ segmentLabel(segment) }}</span>
            <span class="badge" [class]="segment.status">{{ statusLabel(segment) }}</span>
          </button>
          @if (isOpen(segment)) {
            <pre #body class="body">{{
              segment.lines.join(
                '
'
              )
            }}</pre>
          }
          @if (segment.hint === remoteAuth && segment.hintTarget) {
            <p class="hint">
              This step needs to sign in to <code>{{ segment.hintTarget }}</code
              >. Sign that repository in and run the operation again.
            </p>
          } @else if (segment.hint) {
            <p class="hint">
              The failure is classified as <code>{{ segment.hint }}</code>
              @if (segment.hintTarget) {
                , for <code>{{ segment.hintTarget }}</code>
              }
              .
            </p>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    :host {
      display: block;
    }
    .lede {
      margin: 0 0 0.5rem;
      color: #6b7280;
      font-size: 0.9rem;
    }
    .waiting {
      margin: 0;
      color: #6b7280;
      font-style: italic;
    }
    .segments {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .segment {
      border-top: 1px solid #e5e7eb;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.4rem 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    /*
     * The chevron is drawn, not typed. The two explorer SPAs use literal ▸/▾ characters and both
     * render tofu in a font that lacks them; a bordered pseudo-element cannot, and it rotates.
     */
    .chevron {
      flex: 0 0 auto;
      width: 0;
      height: 0;
      border-top: 0.32rem solid transparent;
      border-bottom: 0.32rem solid transparent;
      border-left: 0.42rem solid #6b7280;
      transition: transform 0.12s ease-in-out;
    }
    .segment.open .chevron {
      transform: rotate(90deg);
    }
    .name {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .badge {
      flex: 0 0 auto;
      padding: 0.05rem 0.4rem;
      border-radius: 0.6rem;
      font-size: 0.75rem;
      background: #f3f4f6;
      color: #374151;
    }
    .badge.running {
      background: #dbeafe;
      color: #1d4ed8;
    }
    .badge.ok {
      background: #dcfce7;
      color: #15803d;
    }
    .badge.failed {
      background: #fee2e2;
      color: #b91c1c;
    }
    .body {
      max-height: 18rem;
      margin: 0 0 0.5rem 0.92rem;
      padding: 0.4rem 0.6rem;
      overflow: auto;
      border-radius: 0.3rem;
      background: #111827;
      color: #e5e7eb;
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
      font-size: 0.8rem;
      white-space: pre-wrap;
    }
    .hint {
      margin: 0 0 0.5rem 0.92rem;
      color: #b91c1c;
      font-size: 0.85rem;
    }
    @media (prefers-reduced-motion: reduce) {
      .chevron {
        transition: none;
      }
    }
  `,
})
export class StartingPanel {
  /** The process to follow. */
  readonly processId = input.required<string>();

  /** The operation reached its terminal frame. The host refreshes everything it just changed. */
  readonly settled = output<void>();

  protected readonly log = inject(ProcessLog);
  protected readonly remoteAuth = HINT_REMOTE_AUTH;

  private readonly bodies = viewChildren<ElementRef<HTMLElement>>('body');

  /** Segments the user has opened or closed by hand. An entry here outranks the default forever. */
  private readonly manual = signal<ReadonlyMap<string, boolean>>(new Map());

  constructor() {
    effect(() => this.log.attach(this.processId(), () => this.settled.emit()));
    inject(DestroyRef).onDestroy(() => this.log.detach());

    // After the frame that added the line, not before it: the height it scrolls to is the height
    // the line just created.
    afterRenderEffect(() => {
      this.log.segments();
      for (const body of this.bodies()) {
        body.nativeElement.scrollTop = body.nativeElement.scrollHeight;
      }
    });
  }

  protected isOpen(segment: ProcessSegment): boolean {
    return this.manual().get(segment.name) ?? segment.status === 'running';
  }

  protected toggle(segment: ProcessSegment): void {
    const open = this.isOpen(segment);
    this.manual.update((manual) => new Map(manual).set(segment.name, !open));
  }

  /** What a segment's head says: its name, or for the `queued` wait, what it is waiting for. */
  protected segmentLabel(segment: ProcessSegment): string {
    if (segment.name !== QUEUED_SEGMENT) {
      return segment.name;
    }
    return segment.lines.at(-1)?.trim() || 'waiting for a runner';
  }

  protected statusLabel(segment: ProcessSegment): string {
    if (segment.status === 'running') {
      return segment.name === QUEUED_SEGMENT ? 'waiting' : 'running';
    }
    return segment.status === 'ok' ? 'ok' : 'failed';
  }
}
