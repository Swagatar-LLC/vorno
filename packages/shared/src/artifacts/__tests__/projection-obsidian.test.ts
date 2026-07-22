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
  it('copies artifacts preserving <rootId>/<relPath> structure', () => {
    write(workspaceRoot, 'sessions/s1/plans/p.md', '# P\n[[q]]');
    const roadmap = join(tempDir, 'roadmap');
    write(roadmap, 'decisions/adr.md', '# ADR');

    const uris = [
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' }),
      formatArtifactUri({ rootId: 'roadmap', relPath: 'decisions/adr.md' }),
    ];
    const result = exportObsidianVault({
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

  it('skips denied URIs with a reason (containment + unregistered)', () => {
    write(workspaceRoot, 'sessions/s1/data/notes.txt', 'plain'); // unregistered, unpinned
    const uris = [
      formatArtifactUri({ rootId: 'ghost', relPath: 'x.md' }), // containment
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/data/notes.txt' }), // unregistered
      'not a valid uri',
    ];
    const result = exportObsidianVault({ workspaceRootPath: workspaceRoot, uris, destDir });
    expect(result.exported).toEqual([]);
    expect(result.skipped.some((s) => s.includes('containment-denied'))).toBe(true);
    expect(result.skipped.some((s) => s.includes('unregistered-type'))).toBe(true);
    expect(result.skipped.some((s) => s.includes('invalid-uri'))).toBe(true);
  });
});
