import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { LineRange } from './file-viewer';

/**
 * The two ways into the file browser from elsewhere on the page.
 *
 * **Both are URL writes, and that is the whole design.** The open file costs a request, so by this
 * codebase's rule it is addressable state and lives in the query string — which means a cross-tab
 * jump, a deep link pasted into chat, a reload and the back button are all one code path instead of
 * four. The Files panel loads off an `effect` watching the URL and never off a click, so a press and
 * a pasted link are indistinguishable to it.
 *
 * The parameters:
 *
 * - `tab=files` — the jump switches tabs, because an "open in source" that opened a file behind
 *   another tab would look like nothing happened.
 * - `path` — the open file, exact.
 * - `lines` — `12` or `12-20`, the anchored range: painted and scrolled to.
 * - `near` — a *possibly stale* path to find the closest match for. Consumed once and cleared, so
 *   the URL settles on the path that was actually opened rather than the one that was guessed from.
 */
@Injectable({ providedIn: 'root' })
export class FileNavigation {
  private readonly router = inject(Router);

  /**
   * **Open at an exact line range.** A chat reference row and an agent transcript path.
   *
   * The path is taken at its word and is **not** looked for in the tree: `/files/content` consults
   * git for nothing, so a log or a generated file — neither of which is in the listing — opens
   * exactly as well as a tracked one. That is the case this entry point exists for.
   */
  openAt(path: string, range: LineRange | null = null): void {
    this.write({ tab: 'files', path, lines: range ? formatRange(range) : null, near: null });
  }

  /**
   * **Open the closest match to a path that may have moved.** For a caller that only knows a path as
   * of some earlier moment, and has to admit a rename may have happened since.
   *
   * It seeds the name filter with the path *exactly as if the user had typed it*, so the tree
   * narrows and expands and the user can see **why** — a browser that silently jumped somewhere near
   * where you asked would be worse than one that missed.
   */
  openClosest(path: string): void {
    this.write({ tab: 'files', near: path, path: null, lines: null });
  }

  private write(params: Readonly<Record<string, string | null>>): void {
    const tree = this.router.parseUrl(this.router.url);
    const query: Record<string, string> = { ...(tree.queryParams as Record<string, string>) };
    for (const [key, value] of Object.entries(params)) {
      if (value === null) {
        delete query[key];
      } else {
        query[key] = value;
      }
    }
    tree.queryParams = query;
    void this.router.navigateByUrl(tree);
  }
}

/** `12` for one line, `12-20` for a span. The form a chip prints and a URL carries. */
export function formatRange(range: LineRange): string {
  return range.startLine === range.endLine
    ? `${range.startLine}`
    : `${range.startLine}-${range.endLine}`;
}

/**
 * Read a `lines` parameter.
 *
 * Anything unreadable is no anchor rather than an error: the parameter is hand-editable and arrives
 * from other services, and a malformed one should cost the highlight, never the file.
 */
export function parseRange(value: string | null): LineRange | null {
  if (!value) {
    return null;
  }
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) {
    return null;
  }
  return { startLine: start, endLine: end };
}

/**
 * The closest of the candidate paths to a possibly-stale one, or null when none is plausible.
 *
 * The ranking is deliberately simple and explainable, because the user can see the seeded filter and
 * has to be able to agree with the answer: an exact path wins, then the same filename, then the
 * filename with the deepest shared trailing run of segments. **Nothing plausible means nothing is
 * selected** — the seeded filter stays, showing what was looked for, and the user picks. Opening the
 * wrong file with confidence is the failure worth avoiding here.
 */
export function closestMatch(candidates: readonly string[], wanted: string): string | null {
  const target = segmentsOf(wanted);
  if (target.length === 0) {
    return null;
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate === wanted) {
      return candidate;
    }
    const score = sharedTail(segmentsOf(candidate), target);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // A shared tail of zero segments means not even the filename matched, which is not a match at all.
  return bestScore > 0 ? best : null;
}

function segmentsOf(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function sharedTail(left: readonly string[], right: readonly string[]): number {
  let shared = 0;
  while (
    shared < left.length &&
    shared < right.length &&
    left[left.length - 1 - shared] === right[right.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}
