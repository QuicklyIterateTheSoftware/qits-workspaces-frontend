import { InjectionToken } from '@angular/core';

/**
 * The part of `window.location` this page uses, named so a spec can hand over something else.
 *
 * The same seam {@link ../api/event-source#EVENT_SOURCE_FACTORY} is, for the same reason: the
 * hand-off to the editor is a **full** navigation — the editor lives on another origin and is not
 * a route — so it goes through `location.assign` and never through the router. A spec that let
 * that run would navigate the test runner out of the page it is asserting on.
 */
export interface BrowserLocation {
  /** The host of the page as it was served, without the port. */
  hostname(): string;

  /** Leave for another origin. Nothing after this call runs in a real browser. */
  assign(url: string): void;
}

/** How this application leaves for an origin the router does not own. */
export const BROWSER_LOCATION = new InjectionToken<BrowserLocation>('qits.browser-location', {
  providedIn: 'root',
  factory: () => ({
    hostname: () => location.hostname,
    assign: (url: string) => location.assign(url),
  }),
});

/**
 * Where a project's editor answers: `editor.<slug>.` in front of AN ORIGIN THE PLATFORM STATES,
 * and in front of nothing this page worked out for itself.
 *
 * **Both origins come from the edge's navigation document** (`/main-navigation` —
 * `EnvironmentAuthority` on the edge side, rooted in the platform's configured domain), the same
 * statement every cross-application link in the sidebar is already composed from. Scheme and port
 * travel with whichever is used, so a plain-http local platform hands off to plain http.
 *
 * **`projectOrigin` is preferred, and it is the whole point of the pair.** The editor is a
 * four-label host — `editor.<slug>.<env>.<domain>` — so the name it is composed against must carry
 * the environment label. `origin`/`environmentOrigin` does not always: for the default environment
 * it has historically been the bare apex, because that is where that environment is *served*.
 * `projectOrigin` is the same environment's origin with the env label ALWAYS spelled out, which is
 * exactly the name the edge routes an editor by. Given both, this composes against `projectOrigin`.
 *
 * `environmentOrigin` remains the fallback arm, reproducing what shipped before, for one case only:
 * an older edge that serves no `projectOrigin` yet. It composes the three-label short form, which
 * routed through the edge's default-environment fallthrough — so the arm stops being useful the day
 * that fallthrough is removed, and it is here for the rollout window and not as a second answer.
 *
 * This function has been wrong three times, every time by deciding a piece of the name instead of
 * asking for it:
 *
 * 1. It shipped deriving from `location.hostname` by dropping two labels — an
 *    `<app>.<project>.<env>.<domain>` host shape no deployment serves. The first real click landed
 *    on `https://editor.qits.eu/`, somebody else's domain.
 * 2. The corrected label count was still string surgery on this page's own address, which is a
 *    guess that happened to be right. The DOMAIN is configured — the bootstrap states it, the
 *    certificate is ordered against it, the edge publishes it.
 * 3. Then the ENVIRONMENT label, once the editor became four-label: whether an env label belongs in
 *    the name — and which — is not this client's to decide either. A page served from the apex
 *    cannot see the environment it is in, and no amount of reading `origin` reveals it. That is
 *    what `projectOrigin` exists for: the server states the full authority, and this function only
 *    ever puts `editor.<slug>.` in front of it.
 *
 * Ask; never derive. The prefix is the only thing composed here.
 *
 * `null` while the platform has stated neither (the document not loaded yet, or `ng serve` with no
 * edge in front), for a statement that is not an origin, and for an empty slug. The page keeps
 * asking rather than guessing.
 */
export function editorOrigin(
  projectOrigin: string | undefined,
  environmentOrigin: string | undefined,
  projectSlug: string,
): string | null {
  if (projectSlug === '') {
    return null;
  }
  const stated = statedOrigin(projectOrigin) ?? statedOrigin(environmentOrigin);
  if (!stated) {
    return null;
  }
  return `${stated.protocol}//editor.${projectSlug}.${stated.host}/`;
}

/**
 * One of the document's origin statements, parsed — or `null` for "the platform did not state
 * this one", which is what an unparseable value is treated as too. A statement that is not an
 * origin names no host to put a prefix in front of, so it is not a statement.
 */
function statedOrigin(stated: string | undefined): URL | null {
  if (!stated) {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(stated);
  } catch {
    return null;
  }
  return origin.host ? origin : null;
}
