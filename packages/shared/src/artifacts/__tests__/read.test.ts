import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readArtifactByUri } from '../read.ts';
import { indexArtifacts } from '../scan.ts';
import { setArtifactState } from '../store.ts';
import { formatArtifactUri } from '../uri.ts';
import { hashString } from '../content.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'artifacts-read-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const abs = join(workspaceRoot, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function wsUri(relPath: string): string {
  return formatArtifactUri({ rootId: 'workspace', relPath });
}

describe('readArtifactByUri gate', () => {
  it('reads a registered, contained artifact with a correct content hash', async () => {
    const body = '# Doc\n\nknown string';
    write('sessions/s1/plans/p.md', body);
    const result = await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri: wsUri('sessions/s1/plans/p.md') });
    expect(result).not.toBeNull();
    expect(result!.content).toBe(body);
    expect(result!.version.contentHash).toBe(hashString(body));
  });

  it('denies an unregistered extension unless explicitly pinned', async () => {
    write('sessions/s1/data/notes.txt', 'plain text');
    const uri = wsUri('sessions/s1/data/notes.txt');

    // unregistered + not pinned → denied
    expect(await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri })).toBeNull();

    // pin it → now allowed
    setArtifactState(workspaceRoot, uri, { pinned: true });
    const result = await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri });
    expect(result?.content).toBe('plain text');
  });

  it('denies a path outside any root (containment)', async () => {
    // craft an unknown-root URI
    const uri = formatArtifactUri({ rootId: 'ghost', relPath: 'secret.md' });
    expect(await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri })).toBeNull();
  });

  it('enforces the size cap', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1); // just over 2 MB
    write('sessions/s1/data/big.md', big);
    expect(
      await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri: wsUri('sessions/s1/data/big.md') }),
    ).toBeNull();
  });

  // Regression for the G2b review blocker F1 (ADR-0016 §4 door 4): read is
  // gated by INDEX MEMBERSHIP, not by extension registration. A contained,
  // registered-extension file the index never surfaces must be denied.
  it('denies contained registered-extension files that are NOT indexed (F1 probe)', async () => {
    // The indexable artifact.
    write('sessions/s1/plans/p.md', '# Plan');
    // Contained, registered extensions, deliberately OUTSIDE the scan surface —
    // the reviewer's probe files.
    write('sources/email/config.json', '{"apiKey":"SECRET-12345"}');
    write('automations.json', '{"hooks":[]}');
    write('README.md', '# Workspace readme');
    // Inside a session but outside plans/ + data/.
    write('sessions/s1/notes.md', '# Not a plan artifact');

    // Index lists exactly the plan artifact.
    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    expect(artifacts.map((a) => a.uri)).toEqual([wsUri('sessions/s1/plans/p.md')]);

    // Every unindexed probe is DENIED despite containment + registered extension.
    for (const rel of ['sources/email/config.json', 'automations.json', 'README.md', 'sessions/s1/notes.md']) {
      expect(await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri: wsUri(rel) })).toBeNull();
    }

    // The indexed artifact is still served.
    const ok = await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri: wsUri('sessions/s1/plans/p.md') });
    expect(ok?.content).toBe('# Plan');
  });

  it('pinning is the deliberate escape hatch for an unindexed contained file', async () => {
    write('notes/todo.md', '# Pinned note');
    const uri = wsUri('notes/todo.md');
    expect(await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri })).toBeNull();
    setArtifactState(workspaceRoot, uri, { pinned: true });
    const result = await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri });
    expect(result?.content).toBe('# Pinned note');
  });

  it('serves an archived indexed artifact (archival is lifecycle, not a read restriction)', async () => {
    write('sessions/s1/plans/old.md', '# Old plan');
    const uri = wsUri('sessions/s1/plans/old.md');
    setArtifactState(workspaceRoot, uri, { archived: true });
    const result = await readArtifactByUri({ workspaceRootPath: workspaceRoot, uri });
    expect(result?.content).toBe('# Old plan');
  });
});
