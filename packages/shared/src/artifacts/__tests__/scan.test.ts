import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexArtifacts, indexArtifactUris } from '../scan.ts';
import { setArtifactState } from '../store.ts';
import { formatArtifactUri } from '../uri.ts';
import type { ArtifactEntry } from '@craft-agent/core/types';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'artifacts-scan-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function write(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write a minimal session.jsonl whose header line drives the context join. */
function writeSession(
  id: string,
  header: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    id,
    workspaceRootPath: workspaceRoot,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...header,
  });
  write(join(workspaceRoot, 'sessions', id, 'session.jsonl'), line + '\n');
}

function byUri(artifacts: ArtifactEntry[]): Record<string, ArtifactEntry> {
  return Object.fromEntries(artifacts.map((a) => [a.uri, a]));
}

describe('indexArtifacts', () => {
  it('indexes session plans and data with origin kind + sessionId', () => {
    writeSession('s1', {});
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'plan.md'), '# The Plan');
    write(join(workspaceRoot, 'sessions', 's1', 'data', 'nested', 'out.md'), '# Data Out');

    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const plan = artifacts.find((a) => a.origin.kind === 'session-plan');
    const data = artifacts.find((a) => a.origin.kind === 'session-data');
    expect(plan?.origin.sessionId).toBe('s1');
    expect(plan?.title).toBe('The Plan');
    expect(plan?.type).toBe('markdown');
    expect(data?.origin.sessionId).toBe('s1');
    expect(data?.title).toBe('Data Out');
  });

  it('picks up non-markdown registered types (.canvas) — no longer .md-only', () => {
    writeSession('s1', {});
    write(join(workspaceRoot, 'sessions', 's1', 'data', 'board.canvas'), '{"nodes":[]}');
    write(join(workspaceRoot, 'sessions', 's1', 'data', 'skip.png'), 'binary-ish');

    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const uris = artifacts.map((a) => a.uri);
    expect(uris.some((u) => u.endsWith('board.canvas'))).toBe(true);
    const canvas = artifacts.find((a) => a.uri.endsWith('board.canvas'));
    expect(canvas?.type).toBe('json-canvas');
    expect(canvas?.title).toBe('board.canvas');
    // .png is not registered → excluded.
    expect(uris.some((u) => u.endsWith('skip.png'))).toBe(false);
  });

  it('reads frontmatter title/tags/metadata; title precedence FM > heading > basename', () => {
    writeSession('s1', {});
    write(
      join(workspaceRoot, 'sessions', 's1', 'plans', 'fm.md'),
      '---\ntitle: Front Title\ntags:\n  - alpha\n  - beta\nid: DOC-1\n---\n# Heading Title\nbody',
    );
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'heading.md'), '# Just Heading');
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'plain.md'), 'no heading, no fm');

    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const map = byUri(artifacts);
    const fm = map[formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/fm.md' })]!;
    expect(fm.title).toBe('Front Title');
    expect(fm.tags).toEqual(['alpha', 'beta']);
    expect(fm.metadata).toMatchObject({ title: 'Front Title', id: 'DOC-1' });

    const heading = map[formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/heading.md' })]!;
    expect(heading.title).toBe('Just Heading');
    const plain = map[formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/plain.md' })]!;
    expect(plain.title).toBe('plain.md');
  });

  it('scans a configured corpus root with origin kind corpus', () => {
    const roadmap = join(tempDir, 'roadmap');
    write(join(roadmap, 'decisions', 'adr.md'), '# ADR');
    const { artifacts, skippedRoots } = indexArtifacts({
      workspaceRootPath: workspaceRoot,
      configuredRoots: { roadmap },
    });
    expect(skippedRoots).toEqual([]);
    const adr = artifacts.find((a) => a.uri.endsWith('adr.md'));
    expect(adr?.origin.kind).toBe('corpus');
    expect(adr?.uri).toBe(formatArtifactUri({ rootId: 'roadmap', relPath: 'decisions/adr.md' }));
  });

  it('joins session context (projectId, labels, status) onto origins', () => {
    writeSession('s1', {
      projectId: 'proj_123',
      labels: ['label-a'],
      sessionStatus: 'todo', // built-in status survives listSessions validation
    });
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# P');

    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const p = artifacts.find((a) => a.origin.kind === 'session-plan');
    expect(p?.origin.projectId).toBe('proj_123');
    expect(p?.origin.labels).toEqual(['label-a']);
    // sessionStatus flows through listSessions' validation (built-in ids pass).
    expect(p?.origin.sessionStatus).toBe('todo');
  });

  it('tolerates a corrupt session header (keeps artifact, skips the join)', () => {
    write(join(workspaceRoot, 'sessions', 's1', 'session.jsonl'), '{ not valid json\n');
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# P');
    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const p = artifacts.find((a) => a.origin.kind === 'session-plan');
    expect(p).toBeDefined();
    expect(p?.origin.projectId).toBeUndefined();
  });

  it('excludes archived artifacts unless includeArchived is set', () => {
    writeSession('s1', {});
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# P');
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' });
    setArtifactState(workspaceRoot, uri, { archived: true });

    const excluded = indexArtifacts({ workspaceRootPath: workspaceRoot });
    expect(excluded.artifacts.some((a) => a.uri === uri)).toBe(false);

    const included = indexArtifacts({ workspaceRootPath: workspaceRoot, includeArchived: true });
    const found = included.artifacts.find((a) => a.uri === uri);
    expect(found?.archived).toBe(true);
  });

  it('stamps pinned state onto entries', () => {
    writeSession('s1', {});
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# P');
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' });
    setArtifactState(workspaceRoot, uri, { pinned: true });
    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    expect(artifacts.find((a) => a.uri === uri)?.pinned).toBe(true);
  });

  // F2 (G2b review): skipped roots are rootId + reason — never absolute paths.
  it('reports a missing configured root as {rootId, reason} with no absolute path', () => {
    const { skippedRoots } = indexArtifacts({
      workspaceRootPath: workspaceRoot,
      configuredRoots: { ghost: join(tempDir, 'does-not-exist') },
    });
    expect(skippedRoots).toEqual([{ rootId: 'ghost', reason: 'missing' }]);
    for (const s of skippedRoots) {
      expect(s.rootId.includes('/')).toBe(false);
    }
  });

  // A3 (G2b review): a bare #hashtag line is not a heading.
  it('does not mistake a #hashtag line for a heading title', () => {
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'tagged.md'), '#todo\n\n# Real Title\nbody');
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'only-tag.md'), '#todo\nbody');
    const { artifacts } = indexArtifacts({ workspaceRootPath: workspaceRoot });
    const byRel = (rel: string) =>
      artifacts.find((a) => a.uri === formatArtifactUri({ rootId: 'workspace', relPath: rel }));
    expect(byRel('sessions/s1/plans/tagged.md')?.title).toBe('Real Title');
    expect(byRel('sessions/s1/plans/only-tag.md')?.title).toBe('only-tag.md');
  });

  // F1 support: the URI-set variant matches the full index's surface.
  it('indexArtifactUris matches the URIs indexArtifacts surfaces (archived included)', () => {
    writeSession('s1', {});
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# P');
    write(join(workspaceRoot, 'sessions', 's1', 'data', 'd.json'), '{}');
    write(join(workspaceRoot, 'unindexed.md'), '# Not scanned');
    const archivedUri = formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' });
    setArtifactState(workspaceRoot, archivedUri, { archived: true });

    const uris = indexArtifactUris({ workspaceRootPath: workspaceRoot });
    const full = indexArtifacts({ workspaceRootPath: workspaceRoot, includeArchived: true });
    expect(uris).toEqual(new Set(full.artifacts.map((a) => a.uri)));
    expect(uris.has(formatArtifactUri({ rootId: 'workspace', relPath: 'unindexed.md' }))).toBe(false);
  });
});
