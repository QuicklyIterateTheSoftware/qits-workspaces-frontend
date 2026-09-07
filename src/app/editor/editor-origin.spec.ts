import { editorOrigin } from './editor-origin';

/**
 * The hand-off's address: `editor.<slug>.` in front of an origin THE PLATFORM STATES — the
 * navigation document's, the same statement every sidebar link composes against.
 *
 * These specs replaced two generations that blessed deriving the domain from this page's own
 * hostname (first dropping two labels — the first real click landed on `https://editor.qits.eu/`,
 * somebody else's domain — then one). The address is asked for now, never derived, so what is
 * pinned here is composition alone.
 *
 * The third generation is the split below: `projectOrigin` carries the environment label always,
 * `environmentOrigin` is the environment as it is *served* and drops the label for the default
 * environment. The editor is a four-label host, so the first is the one to compose against, and
 * which label belongs there is no more this client's to decide than the domain was.
 */
describe('editorOrigin', () => {
  it('composes against the project origin, which always spells the environment label', () => {
    // The default environment's own origin is the bare apex; its projectOrigin is not. The editor
    // is `editor.<slug>.<env>.<domain>` on every environment, default included.
    expect(editorOrigin('https://dev.wohlben.dev', 'https://wohlben.dev', 'qits')).toBe(
      'https://editor.qits.dev.wohlben.dev/',
    );
  });

  it('prefers the project origin over the environment origin whenever both are stated', () => {
    expect(editorOrigin('https://dev.wohlben.eu', 'https://wohlben.eu', 'qits')).toBe(
      'https://editor.qits.dev.wohlben.eu/',
    );
  });

  it('keeps the stated scheme and port — a plain-http platform hands off to plain http', () => {
    expect(editorOrigin('http://dev.localhost:8080', undefined, 'qits')).toBe(
      'http://editor.qits.dev.localhost:8080/',
    );
  });

  it('sends a reader to their own project, not to anything the origin names', () => {
    expect(editorOrigin('https://dev.wohlben.eu', undefined, 'other')).toBe(
      'https://editor.other.dev.wohlben.eu/',
    );
  });

  /**
   * The rollout arm, and nothing more. An edge that serves no `projectOrigin` yet still gets the
   * address that shipped before — the short `editor.<slug>.<domain>` form, which reaches the
   * editor only through the edge's default-environment fallthrough. These are the previous
   * generation's assertions verbatim, moved onto this arm, so the fallback is pinned as *exactly*
   * what it replaced and not as a second opinion.
   */
  describe('falling back to the environment origin, for an edge that states no project origin', () => {
    it('puts editor.<slug>. in front of the stated origin', () => {
      expect(editorOrigin(undefined, 'https://wohlben.eu', 'qits')).toBe(
        'https://editor.qits.wohlben.eu/',
      );
    });

    it('keeps the stated scheme and port', () => {
      expect(editorOrigin(undefined, 'http://dev.localhost:8080', 'qits')).toBe(
        'http://editor.qits.dev.localhost:8080/',
      );
    });

    it('sends a reader to their own project, not to anything the origin names', () => {
      expect(editorOrigin(undefined, 'https://wohlben.eu', 'other')).toBe(
        'https://editor.other.wohlben.eu/',
      );
    });
  });

  it('answers null while the platform has stated neither origin', () => {
    // The document not loaded yet, or `ng serve` with no edge in front. The page keeps waiting
    // rather than inventing an address.
    expect(editorOrigin(undefined, undefined, 'qits')).toBeNull();
    expect(editorOrigin('', '', 'qits')).toBeNull();
  });

  it('answers null for statements that are not origins', () => {
    expect(editorOrigin(undefined, 'not an origin', 'qits')).toBeNull();
    expect(editorOrigin('not an origin', undefined, 'qits')).toBeNull();
    expect(editorOrigin('not an origin', 'not an origin either', 'qits')).toBeNull();
  });

  it('answers null for an empty slug, which no address states', () => {
    expect(editorOrigin('https://dev.wohlben.eu', 'https://wohlben.eu', '')).toBeNull();
  });
});
