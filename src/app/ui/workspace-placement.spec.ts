import type { WorkspaceDto } from '../api/dto';
import { isDirectRegular, isDirty, isMoveUnknown, isUnpushed } from './workspace-placement';

/** The part of a workspace these predicates read. A row, or anything shaped like one. */
type Row = Pick<WorkspaceDto, 'placement' | 'admin' | 'editor' | 'clean' | 'pushed'>;

const row = (over: Partial<Row> = {}): Row => ({
  placement: undefined,
  admin: undefined,
  editor: undefined,
  clean: true,
  pushed: true,
  ...over,
});

describe('isDirectRegular', () => {
  it('is true for a plain row an older service answers nothing extra about', () => {
    expect(isDirectRegular(row() as WorkspaceDto)).toBe(true);
  });

  it('is false for a RUNNER row, placed or not yet', () => {
    expect(isDirectRegular(row({ placement: 'RUNNER' }) as WorkspaceDto)).toBe(false);
  });

  it('is false for an admin row, even while DIRECT', () => {
    expect(isDirectRegular(row({ admin: true }) as WorkspaceDto)).toBe(false);
  });

  it('is false for the editor row, even while DIRECT', () => {
    expect(isDirectRegular(row({ editor: true }) as WorkspaceDto)).toBe(false);
  });
});

describe('isDirty', () => {
  it('is true only when clean is literally false', () => {
    expect(isDirty(row({ clean: false }) as WorkspaceDto)).toBe(true);
    expect(isDirty(row({ clean: true }) as WorkspaceDto)).toBe(false);
    expect(isDirty(row({ clean: null }) as WorkspaceDto)).toBe(false);
  });
});

describe('isUnpushed', () => {
  it('is true only when the tree is known clean and pushed is literally false', () => {
    expect(isUnpushed(row({ clean: true, pushed: false }) as WorkspaceDto)).toBe(true);
  });

  it('is false on a dirty tree — that is refused for being dirty, not for being unpushed too', () => {
    expect(isUnpushed(row({ clean: false, pushed: false }) as WorkspaceDto)).toBe(false);
  });

  it('is false while pushed is unknown rather than literally false', () => {
    expect(isUnpushed(row({ clean: true, pushed: null }) as WorkspaceDto)).toBe(false);
    expect(isUnpushed(row({ clean: true, pushed: undefined }) as WorkspaceDto)).toBe(false);
  });
});

describe('isMoveUnknown', () => {
  it('is true when clean itself is unknown', () => {
    expect(isMoveUnknown(row({ clean: null }) as WorkspaceDto)).toBe(true);
  });

  it('is true when the tree is clean but pushed is null or simply absent', () => {
    expect(isMoveUnknown(row({ clean: true, pushed: null }) as WorkspaceDto)).toBe(true);
    expect(isMoveUnknown(row({ clean: true, pushed: undefined }) as WorkspaceDto)).toBe(true);
  });

  it('is false once both are known', () => {
    expect(isMoveUnknown(row({ clean: true, pushed: true }) as WorkspaceDto)).toBe(false);
    expect(isMoveUnknown(row({ clean: true, pushed: false }) as WorkspaceDto)).toBe(false);
  });
});
