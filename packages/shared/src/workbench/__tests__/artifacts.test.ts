/**
 * Tests for the Review Workbench artifact index + read (ADR-0014, PLAN-024).
 *
 * Real temp directories exercise the recursive scan, containment boundary, and
 * content-hash computation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WorkbenchInstanceV1 } from '@craft-agent/core/types';
import {
  indexArtifacts,
  readArtifact,
  resolveContainedArtifact,
  computeContentHash,
} from '../artifacts.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'workbench-artifacts-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function makeInstance(overrides: Partial<WorkbenchInstanceV1> = {}): WorkbenchInstanceV1 {
  return {
    schemaVersion: 1,
    id: 'wb_test',
    type: 'review',
    title: 'test',
    corpusRoots: [],
    artifactUris: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function write(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('indexArtifacts', () => {
  it('scans corpus roots for *.md and derives titles from the first heading', () => {
    const corpus = join(tempDir, 'corpus');
    write(join(corpus, 'a.md'), '# Alpha Doc\n\nbody');
    write(join(corpus, 'nested', 'b.md'), 'no heading here');
    write(join(corpus, 'ignore.txt'), 'not markdown');

    const { artifacts, skippedRoots } = indexArtifacts(workspaceRoot, makeInstance({ corpusRoots: [corpus] }));
    expect(skippedRoots).toEqual([]);
    const byUri = Object.fromEntries(artifacts.map((a) => [a.uri, a]));
    expect(byUri[join(corpus, 'a.md')]!.title).toBe('Alpha Doc');
    expect(byUri[join(corpus, 'a.md')]!.kind).toBe('corpus');
    // No heading → filename fallback.
    expect(byUri[join(corpus, 'nested', 'b.md')]!.title).toBe('b.md');
    // .txt excluded.
    expect(artifacts.some((a) => a.uri.endsWith('ignore.txt'))).toBe(false);
  });

  it('indexes session plans and data with sessionId + kind', () => {
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'plan.md'), '# The Plan');
    write(join(workspaceRoot, 'sessions', 's1', 'data', 'nested', 'out.md'), '# Data Out');

    const { artifacts } = indexArtifacts(workspaceRoot, makeInstance());
    const plan = artifacts.find((a) => a.kind === 'session-plan');
    const data = artifacts.find((a) => a.kind === 'session-data');
    expect(plan?.sessionId).toBe('s1');
    expect(plan?.title).toBe('The Plan');
    expect(data?.sessionId).toBe('s1');
    expect(data?.title).toBe('Data Out');
  });

  it('records a missing corpus root in skippedRoots (never throws)', () => {
    const { artifacts, skippedRoots } = indexArtifacts(
      workspaceRoot,
      makeInstance({ corpusRoots: [join(tempDir, 'does-not-exist')] }),
    );
    expect(artifacts).toEqual([]);
    expect(skippedRoots).toEqual([join(tempDir, 'does-not-exist')]);
  });

  it('records a missing pinned artifactUri in skippedRoots', () => {
    const { skippedRoots } = indexArtifacts(
      workspaceRoot,
      makeInstance({ artifactUris: [join(tempDir, 'gone.md')] }),
    );
    expect(skippedRoots).toContain(join(tempDir, 'gone.md'));
  });
});

describe('containment boundary', () => {
  it('rejects a path outside all roots', () => {
    const corpus = join(tempDir, 'corpus');
    write(join(corpus, 'inside.md'), '# inside');
    const outside = write(join(tempDir, 'outside.md'), '# outside');

    const instance = makeInstance({ corpusRoots: [corpus] });
    expect(resolveContainedArtifact(workspaceRoot, instance, outside)).toBeNull();
    expect(resolveContainedArtifact(workspaceRoot, instance, join(corpus, 'inside.md'))).not.toBeNull();
  });

  it('does not treat a sibling prefix dir as contained', () => {
    const root = join(tempDir, 'root');
    write(join(root, 'x.md'), '# x');
    const sibling = write(join(tempDir, 'root-evil', 'y.md'), '# y');

    const instance = makeInstance({ corpusRoots: [root] });
    expect(resolveContainedArtifact(workspaceRoot, instance, sibling)).toBeNull();
  });

  it('readArtifact returns null for a denied path', async () => {
    const corpus = join(tempDir, 'corpus');
    write(join(corpus, 'ok.md'), '# ok');
    const outside = write(join(tempDir, 'secret.md'), '# secret');

    const instance = makeInstance({ corpusRoots: [corpus] });
    expect(await readArtifact(workspaceRoot, instance, outside)).toBeNull();
  });

  it('allows an exact pinned artifactUri outside corpus roots', async () => {
    const pinned = write(join(tempDir, 'pinned', 'doc.md'), '# Pinned');
    const instance = makeInstance({ artifactUris: [pinned] });
    const result = await readArtifact(workspaceRoot, instance, pinned);
    expect(result).not.toBeNull();
    expect(result!.ref.title).toBe('Pinned');
  });
});

describe('content hash', () => {
  it('changes when the file content changes', async () => {
    const corpus = join(tempDir, 'corpus');
    const file = join(corpus, 'doc.md');
    write(file, '# v1\n\noriginal');

    const instance = makeInstance({ corpusRoots: [corpus] });
    const first = await readArtifact(workspaceRoot, instance, file);
    const hash1 = first!.version.contentHash;
    expect(hash1).toBe(computeContentHash(file));

    writeFileSync(file, '# v2\n\nchanged');
    const second = await readArtifact(workspaceRoot, instance, file);
    expect(second!.version.contentHash).not.toBe(hash1);
  });
});
