import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exportObsidianVault } from '../projection-obsidian.ts';
import { formatArtifactUri } from '../uri.ts';

let tempDir: string;
let workspaceRoot: string;
let destDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'artifacts-proj-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  destDir = join(tempDir, 'vault');
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function write(base: string, relPath: string, content: string): void {
  const abs = join(base, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('exportObsidianVault', () => {
  it('copies artifacts preserving <rootId>/<relPath> structure', async () => {
    write(workspaceRoot, 'sessions/s1/plans/p.md', '# P\n[[q]]');
    const roadmap = join(tempDir, 'roadmap');
    write(roadmap, 'decisions/adr.md', '# ADR');

    const uris = [
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' }),
      formatArtifactUri({ rootId: 'roadmap', relPath: 'decisions/adr.md' }),
    ];
    const result = await exportObsidianVault({
      workspaceRootPath: workspaceRoot,
      configuredRoots: { roadmap },
      uris,
      destDir,
    });

    expect(result.exported).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(destDir, 'workspace', 'sessions/s1/plans/p.md'), 'utf-8')).toBe('# P\n[[q]]');
    expect(readFileSync(join(destDir, 'roadmap', 'decisions/adr.md'), 'utf-8')).toBe('# ADR');
  });

  it('skips denied URIs with a reason (containment + unregistered)', async () => {
    write(workspaceRoot, 'sessions/s1/data/notes.txt', 'plain'); // unregistered, unpinned
    const uris = [
      formatArtifactUri({ rootId: 'ghost', relPath: 'x.md' }), // containment
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/data/notes.txt' }), // unregistered
      'not a valid uri',
    ];
    const result = await exportObsidianVault({ workspaceRootPath: workspaceRoot, uris, destDir });
    expect(result.exported).toEqual([]);
    expect(result.skipped.some((s) => s.includes('containment-denied'))).toBe(true);
    expect(result.skipped.some((s) => s.includes('unregistered-type'))).toBe(true);
    expect(result.skipped.some((s) => s.includes('invalid-uri'))).toBe(true);
  });

  // ADR-0018 (SEC-1 closure): export and read share ONE admissibility gate. A
  // contained, registered-extension file OUTSIDE the indexed shape must be
  // denied by export exactly as read denies it — extension alone is not enough.
  it('denies a contained registered-extension file outside the indexed shape (same gate as read)', async () => {
    write(workspaceRoot, 'README.md', '# Not scan surface');
    write(workspaceRoot, 'sessions/s1/notes.md', '# In session, outside plans/data');
    const uris = [
      formatArtifactUri({ rootId: 'workspace', relPath: 'README.md' }),
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/notes.md' }),
    ];
    const result = await exportObsidianVault({ workspaceRootPath: workspaceRoot, uris, destDir });
    expect(result.exported).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.includes('not-indexed'))).toBe(true);
  });
});
