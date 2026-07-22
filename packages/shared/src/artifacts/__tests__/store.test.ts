import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listRelations,
  addRelation,
  removeRelation,
  getArtifactState,
  setArtifactState,
  getRelationsPath,
  getStatePath,
} from '../store.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'artifacts-store-test-'));
});

afterEach(() => {
  if (workspaceRoot && existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true, force: true });
});

const A = 'vorno-artifact://workspace/a.md';
const B = 'vorno-artifact://workspace/b.md';

describe('relations', () => {
  it('adds a relation and lists it (filtered by either endpoint)', () => {
    const result = addRelation(workspaceRoot, { from: A, to: B, kind: 'derived-from' });
    expect(result.ok).toBe(true);
    expect(listRelations(workspaceRoot)).toHaveLength(1);
    expect(listRelations(workspaceRoot, A)).toHaveLength(1);
    expect(listRelations(workspaceRoot, B)).toHaveLength(1);
    expect(listRelations(workspaceRoot, 'vorno-artifact://workspace/c.md')).toHaveLength(0);
  });

  it('rejects a duplicate (same from+to+kind)', () => {
    addRelation(workspaceRoot, { from: A, to: B, kind: 'references' });
    const dup = addRelation(workspaceRoot, { from: A, to: B, kind: 'references' });
    expect(dup).toEqual({ ok: false, reason: 'duplicate' });
    // Different kind is allowed.
    const other = addRelation(workspaceRoot, { from: A, to: B, kind: 'renders' });
    expect(other.ok).toBe(true);
  });

  it('rejects an invalid payload', () => {
    expect(addRelation(workspaceRoot, { from: '', to: B, kind: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-payload',
    });
  });

  it('removes by id', () => {
    const r = addRelation(workspaceRoot, { from: A, to: B, kind: 'derived-from' });
    if (!r.ok) throw new Error('expected ok');
    expect(removeRelation(workspaceRoot, r.relation.id)).toBe(true);
    expect(listRelations(workspaceRoot)).toHaveLength(0);
    // removing again → false
    expect(removeRelation(workspaceRoot, r.relation.id)).toBe(false);
  });

  it('tolerates a corrupt relations.json (treats as empty)', () => {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(getRelationsPath(workspaceRoot), '{ not json');
    expect(listRelations(workspaceRoot)).toEqual([]);
    // and can still add afterward (overwrites the corrupt file)
    expect(addRelation(workspaceRoot, { from: A, to: B, kind: 'references' }).ok).toBe(true);
    expect(listRelations(workspaceRoot)).toHaveLength(1);
  });
});

describe('lifecycle state', () => {
  it('merges flags and prunes when both are falsy', () => {
    setArtifactState(workspaceRoot, A, { pinned: true });
    expect(getArtifactState(workspaceRoot)[A]?.pinned).toBe(true);

    // merge archived on top
    setArtifactState(workspaceRoot, A, { archived: true });
    const merged = getArtifactState(workspaceRoot)[A];
    expect(merged?.pinned).toBe(true);
    expect(merged?.archived).toBe(true);

    // clear pinned — archived stays, entry survives
    setArtifactState(workspaceRoot, A, { pinned: false });
    expect(getArtifactState(workspaceRoot)[A]?.pinned).toBeUndefined();
    expect(getArtifactState(workspaceRoot)[A]?.archived).toBe(true);

    // clear archived too — both falsy → pruned
    setArtifactState(workspaceRoot, A, { archived: false });
    expect(getArtifactState(workspaceRoot)[A]).toBeUndefined();
  });

  it('tolerates a corrupt state.json', () => {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(getStatePath(workspaceRoot), 'nonsense');
    expect(getArtifactState(workspaceRoot)).toEqual({});
    setArtifactState(workspaceRoot, A, { pinned: true });
    expect(getArtifactState(workspaceRoot)[A]?.pinned).toBe(true);
  });
});
