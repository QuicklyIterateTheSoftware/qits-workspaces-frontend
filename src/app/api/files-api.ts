import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * One gitignored directory, returned as a stub rather than walked.
 *
 * **Being lazy *is* the ignored flag.** The daemon has no separate marker, and it does not need one:
 * content only ever enters the tree through one of these, so "at or under a lazy directory" is an
 * exact test for "git ignores this" — which is what lets the tree dim ignored rows without parsing a
 * single `.gitignore`.
 */
export interface LazyDirDto {
  readonly path: string;
  /** Immediate children only, never a recursive count. It is the number the label shows. */
  readonly childCount: number;
}

/**
 * One level of the working tree.
 *
 * The two levels are **not** the same shape of answer, and building a tree without knowing that is
 * the first thing to get wrong:
 *
 * - **The root** (`GET /files`, no `path`) answers the *whole eager tree* in one request — every
 *   tracked and new file, at full depth, from `git ls-files --cached --others --exclude-standard` —
 *   plus the wholly-ignored directories as stubs. So `paths` holds deep paths with slashes in them,
 *   and the directories between them are implied by the paths rather than listed.
 * - **A directory** (`GET /files?path=…`) answers that one directory a single level deep: its
 *   immediate files in `paths`, and **all** of its immediate subdirectories as stubs — laziness
 *   applies recursively, so arbitrarily deep ignored nesting resolves through the same call.
 *
 * That asymmetry is the reason the tree costs one request plus one per opened directory, rather than
 * one per directory in the repository.
 */
export interface FileListingDto {
  readonly paths: readonly string[];
  readonly lazyDirs: readonly LazyDirDto[];
  readonly generation: string;
}

/** One detected project: where it starts, what it is, and what to call it. */
export interface DetectionProjectDto {
  /** Workspace-root-relative; the empty string for the repository root itself. */
  readonly root: string;
  readonly frameworkId: string;
  readonly label: string;
}

/** Which files belong to one detected framework — the whitelist a quick-access toggle applies. */
export interface FrameworkMembershipDto {
  readonly frameworkId: string;
  readonly root: string;
  readonly label: string;
  readonly memberPaths: readonly string[];
}

/** One test that reaches a source file. Read by the viewer's test/code strip, which lands later. */
export interface TestLinkDto {
  readonly path: string;
  readonly kinds: readonly string[];
}

/** One source file and the tests that reach it. */
export interface FileLinkDto {
  readonly path: string;
  readonly projectRoot?: string;
  readonly tests: readonly TestLinkDto[];
}

/**
 * One file's text, or the flag standing in for it.
 *
 * **`binary: true` says two different things and the body cannot tell you which.** A genuinely binary
 * file and a file over the daemon's 2 MB cap arrive identically, because the cap *soft-degrades* to
 * this shape rather than answering 413. The contract says so in as many words, and the consequence is
 * a copy rule rather than a code rule: say "too large or binary" unless the size is knowable some
 * other way — see {@link FILE_CONTENT_CAP_BYTES}.
 *
 * `content` is omitted entirely when `binary` is true, and is the empty string for a file that is
 * genuinely empty. Those are different screens and the difference is worth keeping.
 */
export interface FileContentDto {
  readonly path: string;
  readonly binary: boolean;
  readonly content?: string;
}

/**
 * The daemon's read cap, in bytes.
 *
 * Written down here because it is the number the viewer's copy quotes, and a reader who sees "too
 * large or binary" deserves to be told what "too large" is. **Nothing on the platform publishes a
 * file's size**, so this constant cannot be used to decide which of the two happened — only to
 * explain why the page cannot tell.
 */
export const FILE_CONTENT_CAP_BYTES = 2 * 1024 * 1024;

/** Frameworks, projects and the source-to-test graph, stamped with the tree they were computed from. */
export interface DetectionDto {
  readonly projects: readonly DetectionProjectDto[];
  readonly frameworks: readonly FrameworkMembershipDto[];
  readonly links: readonly FileLinkDto[];
  readonly generation: string;
}

/**
 * One agent's worktree and what the daemon has detected in it — the two reads the file browser is
 * built from. Every path is relative to the agent's wrapper worktree (qits-1152).
 *
 * Written by hand against `daemons/qits-workspace-daemon/docs/openapi.yml`, which is itself
 * hand-written and carries one acceptance rule: every field named in it is asserted as a literal
 * string by a test in that repository. That document is the contract; this file is its consumer, and
 * a rename on either side is meant to be a two-repository change.
 *
 * Everything goes through {@link WorkspaceDaemonApi}, which appends the path to
 * `/workspaces/container/{id}` verbatim and watches for the daemon going away. Nothing here catches:
 * a 502 is the daemon being gone and the panel renders that state, and swallowing it would leave the
 * page looking empty rather than looking broken.
 */
@Injectable({ providedIn: 'root' })
export class FilesApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * One level of the tree. Omit `path` for the root, which is the whole eager tree in one answer.
   *
   * The `path` parameter is sent only when there is one: the daemon reads absent and blank alike as
   * "the root", but sending `path=` on the first load would make the request that fetches everything
   * look like a request for a directory called nothing.
   */
  async files(workspaceRowId: number, agentId: string, path?: string): Promise<FileListingDto> {
    return this.daemon.get<FileListingDto>(
      workspaceRowId,
      `${agentRoot(agentId)}/files`,
      path ? { path } : undefined,
    );
  }

  /**
   * Frameworks, projects and the test graph.
   *
   * Its `generation` is computed by a byte-identical duplicate of the algorithm `/files` uses, and
   * the whole point of it is that the two can be compared: a detection is applied only while its
   * token matches the tree on screen. See `applyDetection` in the tree model for the rule.
   */
  async detection(workspaceRowId: number, agentId: string): Promise<DetectionDto> {
    return this.daemon.get<DetectionDto>(workspaceRowId, `${agentRoot(agentId)}/detection`);
  }

  /**
   * One file's contents.
   *
   * **It consults git for nothing**, so it reads any regular file inside the agent's worktree, tracked
   * or not. That is what makes the viewer's "open at an exact line range" entry point work for a file
   * that is **not in the tree at all** — a log is usually ignored, and anchoring an event in one is
   * the whole reason that entry point exists.
   *
   * `path` is required here, unlike on `/files`, where its absence means the root.
   */
  async content(workspaceRowId: number, agentId: string, path: string): Promise<FileContentDto> {
    return this.daemon.get<FileContentDto>(workspaceRowId, `${agentRoot(agentId)}/files/content`, {
      path,
    });
  }
}

/** Where one agent's reads live on the daemon. Its root is the agent's wrapper worktree. */
export function agentRoot(agentId: string): string {
  return `/agent-worktrees/${encodeURIComponent(agentId)}`;
}
