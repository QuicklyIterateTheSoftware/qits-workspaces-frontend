import { editorOrigin } from './editor-origin';

/**
 * The hand-off's address: `editor.` in front of an origin THE PLATFORM STATES — the navigation
 * document's, the same statement every sidebar link composes against.
 *
 * These specs replaced two generations that blessed deriving the domain from this page's own
 * hostname (first dropping two labels — the first real click landed on `https://editor.qits.eu/`,
 * somebody else's domain — then one). The address is asked for now, never derived, so what is
 * pinned here is composition alone, and the test below that hands this function an origin naming a
 * host nothing in the runner is served from is the one that says so.
 *
 * The editor is one shared container for the whole platform, reached at `editor.<env>.<domain>` as
 * any other application vhost is, so there is no project label in the name any more. Which project
 * a reader lands in is a `?folder=` the page appends, not a host — see `editor-page`. What survives
 * from the per-project generation is the pair below: `projectOrigin` carries the environment label
 * always, `environmentOrigin` is the environment as it is *served* and drops the label for the
 * default environment, so the first is the one to compose against.
 */
describe('editorOrigin', () => {
  it('composes against the project origin, which always spells the environment label', () => {
    // The default environment's own origin is the bare apex; its projectOrigin is not. The editor
    // is `editor.<env>.<domain>` on every environment, default included.
    expect(editorOrigin('https://dev.wohlben.dev', 'https://wohlben.dev')).toBe(
      'https://editor.dev.wohlben.dev/',
    );
  });

  it('prefers the project origin over the environment origin whenever both are stated', () => {
    expect(editorOrigin('https://dev.wohlben.eu', 'https://wohlben.eu')).toBe(
      'https://editor.dev.wohlben.eu/',
    );
  });

  it('keeps the stated scheme and port — a plain-http platform hands off to plain http', () => {
    expect(editorOrigin('http://dev.localhost:8080', undefined)).toBe(
      'http://editor.dev.localhost:8080/',
    );
  });

  it('composes onto the stated host and never onto the page’s own address', () => {
    // The whole point of the module. The runner is served from somewhere else entirely; whatever
    // the platform states is the only thing the address is built from, labels and all.
    expect(location.hostname).not.toBe('somewhere.else.example');
    expect(editorOrigin('https://staging.somewhere.else.example', undefined)).toBe(
      'https://editor.staging.somewhere.else.example/',
    );
  });

  /**
   * The rollout arm, and nothing more. An edge that serves no `projectOrigin` yet still gets the
   * address composed onto what it does state — the short form, which reaches the editor only
   * through the edge's default-environment fallthrough. These are the previous generation's
   * assertions, moved onto this arm, so the fallback is pinned as *exactly* what it replaced and
   * not as a second opinion.
   */
  describe('falling back to the environment origin, for an edge that states no project origin', () => {
    it('puts editor. in front of the stated origin', () => {
      expect(editorOrigin(undefined, 'https://wohlben.eu')).toBe('https://editor.wohlben.eu/');
    });

    it('keeps the stated scheme and port', () => {
      expect(editorOrigin(undefined, 'http://dev.localhost:8080')).toBe(
        'http://editor.dev.localhost:8080/',
      );
    });
  });

  it('answers null while the platform has stated neither origin', () => {
    // The document not loaded yet, or `ng serve` with no edge in front. The page keeps waiting
    // rather than inventing an address.
    expect(editorOrigin(undefined, undefined)).toBeNull();
    expect(editorOrigin('', '')).toBeNull();
  });

  it('answers null for statements that are not origins', () => {
    expect(editorOrigin(undefined, 'not an origin')).toBeNull();
    expect(editorOrigin('not an origin', undefined)).toBeNull();
    expect(editorOrigin('not an origin', 'not an origin either')).toBeNull();
  });
});
