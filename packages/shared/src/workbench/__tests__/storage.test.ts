/**
 * Tests for the Review Workbench store (ADR-0014, PLAN-024).
 *
 * Real temp directories exercise actual filesystem behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AnnotationV1 } from '@craft-agent/core/types';
import type { ReviewThreadV1 } from '@craft-agent/core/types';
import {
  createWorkbenchInstance,
  listWorkbenchInstances,
  loadWorkbenchInstance,
  updateWorkbenchInstance,
  addThread,
  updateThread,
  removeThread,
  listThreads,
  getWorkbenchInstancePath,
  getThreadPath,
  getWorkbenchThreadsPath,
} from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'workbench-store-test-'));
  workspaceRoot = join(tempDir, 'workspace');
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function makeAnnotation(): AnnotationV1 {
  return {
    id: 'ann_1',
    schemaVersion: 1,
    createdAt: Date.now(),
    body: [{ type: 'note', text: 'looks off' }],
    target: {
      source: { sessionId: 's1', messageId: 'm1' },
      selectors: [{ type: 'text-quote', exact: 'some quoted text' }],
    },
  };
}

function makeThread(workbenchId: string, id: string, artifactUri = '/tmp/a.md'): ReviewThreadV1 {
  return {
    schemaVersion: 1,
    id,
    workbenchId,
    artifactUri,
    artifactVersion: { contentHash: 'deadbeef' },
    annotation: makeAnnotation(),
    kind: 'comment',
    status: 'open',
    sessionLinks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('workbench instance store', () => {
  it('round-trips an instance (create → load → list)', () => {
    const created = createWorkbenchInstance(workspaceRoot, {
      title: 'ALIGN review',
      corpusRoots: ['/some/roadmap'],
    });
    expect(created.id).toMatch(/^wb_[0-9a-f]{8}$/);
    expect(created.type).toBe('review');
    expect(created.schemaVersion).toBe(1);
    expect(existsSync(getWorkbenchInstancePath(workspaceRoot, created.id))).toBe(true);

    const loaded = loadWorkbenchInstance(workspaceRoot, created.id);
    expect(loaded).toEqual(created);

    const listed = listWorkbenchInstances(workspaceRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
  });

  it('applies an additive patch (arrays replace wholesale, identity immutable)', () => {
    const created = createWorkbenchInstance(workspaceRoot, { title: 'orig' });
    const updated = updateWorkbenchInstance(workspaceRoot, created.id, {
      title: 'renamed',
      corpusRoots: ['/a', '/b'],
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('renamed');
    expect(updated!.corpusRoots).toEqual(['/a', '/b']);
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
  });

  it('update on a missing workbench returns null', () => {
    expect(updateWorkbenchInstance(workspaceRoot, 'wb_missing', { title: 'x' })).toBeNull();
  });

  it('lists empty when there is no reviews dir', () => {
    expect(listWorkbenchInstances(workspaceRoot)).toEqual([]);
  });

  it('skips a corrupt workbench.json without throwing', () => {
    const good = createWorkbenchInstance(workspaceRoot, { title: 'good' });
    // Plant a corrupt instance dir.
    const badDir = join(workspaceRoot, 'reviews', 'wb_bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'workbench.json'), '{ not json');

    const listed = listWorkbenchInstances(workspaceRoot);
    expect(listed.map((i) => i.id)).toEqual([good.id]);
  });
});

describe('workbench thread store', () => {
  it('round-trips threads (add → list → update → remove)', () => {
    const wb = createWorkbenchInstance(workspaceRoot, { title: 'wb' });
    const added = addThread(workspaceRoot, makeThread(wb.id, 'thread_a'));
    expect(added).not.toBeNull();
    expect(existsSync(getThreadPath(workspaceRoot, wb.id, 'thread_a'))).toBe(true);

    let threads = listThreads(workspaceRoot, wb.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe('thread_a');

    const updated = updateThread(workspaceRoot, wb.id, 'thread_a', { status: 'resolved' });
    expect(updated!.status).toBe('resolved');
    expect(updated!.id).toBe('thread_a');

    expect(removeThread(workspaceRoot, wb.id, 'thread_a')).toBe(true);
    threads = listThreads(workspaceRoot, wb.id);
    expect(threads).toHaveLength(0);
  });

  it('rejects a duplicate thread id (returns null)', () => {
    const wb = createWorkbenchInstance(workspaceRoot, { title: 'wb' });
    expect(addThread(workspaceRoot, makeThread(wb.id, 'thread_dup'))).not.toBeNull();
    expect(addThread(workspaceRoot, makeThread(wb.id, 'thread_dup'))).toBeNull();
  });

  it('update/remove on a missing thread report not-found', () => {
    const wb = createWorkbenchInstance(workspaceRoot, { title: 'wb' });
    expect(updateThread(workspaceRoot, wb.id, 'thread_missing', { status: 'resolved' })).toBeNull();
    expect(removeThread(workspaceRoot, wb.id, 'thread_missing')).toBe(false);
  });

  it('filters threads by artifactUri', () => {
    const wb = createWorkbenchInstance(workspaceRoot, { title: 'wb' });
    addThread(workspaceRoot, makeThread(wb.id, 'thread_a', '/tmp/a.md'));
    addThread(workspaceRoot, makeThread(wb.id, 'thread_b', '/tmp/b.md'));

    const onlyA = listThreads(workspaceRoot, wb.id, '/tmp/a.md');
    expect(onlyA.map((t) => t.id)).toEqual(['thread_a']);
  });

  it('skips a corrupt thread file without throwing', () => {
    const wb = createWorkbenchInstance(workspaceRoot, { title: 'wb' });
    addThread(workspaceRoot, makeThread(wb.id, 'thread_ok'));
    writeFileSync(join(getWorkbenchThreadsPath(workspaceRoot, wb.id), 'thread_bad.json'), '}{ bad');

    const threads = listThreads(workspaceRoot, wb.id);
    expect(threads.map((t) => t.id)).toEqual(['thread_ok']);
  });
});
