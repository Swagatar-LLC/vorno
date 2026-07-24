import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveRootBindings } from '../roots.ts';
import { FilesystemStorageProvider } from '../storage/filesystem.ts';
import { isWriteCapable } from '../storage/provider.ts';
import { formatArtifactUri } from '../uri.ts';
import { hashString } from '../content.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'artifacts-storage-test-'));
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

describe('resolveRootBindings', () => {
  it('always includes the workspace root as a filesystem provider', () => {
    const b = resolveRootBindings(workspaceRoot);
    const ws = b.get('workspace');
    expect(ws).toBeInstanceOf(FilesystemStorageProvider);
    expect(ws!.kind).toBe('filesystem');
  });

  it('validates configured roots (id regex, absolute path, not workspace)', async () => {
    const roadmap = join(tempDir, 'roadmap');
    const b = resolveRootBindings(workspaceRoot, {
      roadmap,
      workspace: '/somewhere', // shadows reserved id → skipped
      Bad: '/x', // invalid id → skipped
      rel: 'relative/path', // not absolute → skipped
    });
    expect(b.get('roadmap')).toBeInstanceOf(FilesystemStorageProvider);
    expect(b.has('Bad')).toBe(false);
    expect(b.has('rel')).toBe(false);
    // The reserved id stays bound to the workspace path — the shadow was skipped.
    write(join(workspaceRoot, 'a.md'), '# a');
    expect(
      await b.get('workspace')!.exists(formatArtifactUri({ rootId: 'workspace', relPath: 'a.md' })),
    ).toBe(true);
  });

  it('exposes a serializable, read-only capability descriptor (C2: no write impls)', () => {
    const b = resolveRootBindings(workspaceRoot);
    const ws = b.get('workspace')!;
    expect(ws.capabilities).toEqual({
      read: true,
      stat: true,
      list: true,
      contentHash: true,
      write: false,
      delete: false,
      copy: false,
      presign: false,
    });
    // In-process half of the hybrid negotiation agrees with the descriptor.
    expect(isWriteCapable(ws)).toBe(false);
  });
});

describe('FilesystemStorageProvider containment (ADR-0018 door 2)', () => {
  it('reads an in-root URI and hashes the buffer', async () => {
    write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# p');
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' });
    const result = await p.read(uri);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bytes.toString('utf-8')).toBe('# p');
      expect(result.value.meta.contentHash).toBe(hashString('# p'));
      expect(result.value.meta.uri).toBe(uri);
    }
  });

  it('rejects a path outside the bound root (dotdot cannot even be expressed)', async () => {
    write(join(workspaceRoot, 'in.md'), '# in');
    write(join(tempDir, 'outside.md'), '# out');
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    // dotdot is parse-rejected at the URI layer, so containment is belt+braces.
    const result = await p.read('vorno-artifact://workspace/../outside.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
  });

  it('rejects a symlink leaf that escapes the root', async () => {
    const secret = write(join(tempDir, 'secret.md'), '# secret');
    symlinkSync(secret, join(workspaceRoot, 'link.md'));
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'link.md' });
    expect((await p.read(uri)).ok).toBe(false);
    expect((await p.stat(uri)).ok).toBe(false);
    expect(await p.exists(uri)).toBe(false);
  });

  it('rejects a symlinked directory that escapes the root', async () => {
    const secretDir = join(tempDir, 'secretdir');
    write(join(secretDir, 'x.md'), '# x');
    symlinkSync(secretDir, join(workspaceRoot, 'linkdir'));
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'linkdir/x.md' });
    expect((await p.read(uri)).ok).toBe(false);
  });

  it('does not treat a sibling prefix dir as contained', async () => {
    // root = <tmp>/root, sibling = <tmp>/root-evil — segment guard must reject.
    const root = join(tempDir, 'root');
    write(join(root, 'a.md'), '# a');
    write(join(tempDir, 'root-evil', 'y.md'), '# y');
    const p = new FilesystemStorageProvider('root', root);
    expect((await p.read(formatArtifactUri({ rootId: 'root', relPath: 'a.md' }))).ok).toBe(true);
    // The sibling is unaddressable — any traversal spelling is rejected.
    expect((await p.read('vorno-artifact://root/../root-evil/y.md')).ok).toBe(false);
  });

  it('rejects a URI for a foreign root id', async () => {
    write(join(workspaceRoot, 'a.md'), '# a');
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    expect((await p.read('vorno-artifact://ghost/a.md')).ok).toBe(false);
  });

  it('returns not-found for a directory read', async () => {
    mkdirSync(join(workspaceRoot, 'dir'), { recursive: true });
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const result = await p.read(formatArtifactUri({ rootId: 'workspace', relPath: 'dir' }));
    expect(result.ok).toBe(false);
  });

  it('enforces maxBytes with a distinct too-large error', async () => {
    write(join(workspaceRoot, 'big.md'), 'x'.repeat(64));
    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const result = await p.read(formatArtifactUri({ rootId: 'workspace', relPath: 'big.md' }), {
      maxBytes: 16,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('too-large');
  });
});

describe('FilesystemStorageProvider.list', () => {
  it('lists files recursively with URIs, never following symlinks', async () => {
    write(join(workspaceRoot, 'a.md'), '# a');
    write(join(workspaceRoot, 'sub', 'b.md'), '# b');
    const secretDir = join(tempDir, 'secretdir');
    write(join(secretDir, 'x.md'), '# x');
    symlinkSync(secretDir, join(workspaceRoot, 'linkdir'));

    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const uris: string[] = [];
    for await (const meta of p.list()) uris.push(meta.uri);
    expect(uris.sort()).toEqual([
      formatArtifactUri({ rootId: 'workspace', relPath: 'a.md' }),
      formatArtifactUri({ rootId: 'workspace', relPath: 'sub/b.md' }),
    ]);
  });

  it('honors prefix, maxDepth, and skipDir pruning', async () => {
    write(join(workspaceRoot, 'top.md'), '# top');
    write(join(workspaceRoot, 'docs', 'd1.md'), '# d1');
    write(join(workspaceRoot, 'docs', 'skipme', 'd2.md'), '# d2');
    write(join(workspaceRoot, 'docs', 'deep', 'deeper', 'd3.md'), '# d3');

    const p = new FilesystemStorageProvider('workspace', workspaceRoot);
    const uris: string[] = [];
    for await (const meta of p.list({
      prefix: 'docs',
      maxDepth: 1,
      skipDir: (rel) => rel.endsWith('/skipme'),
    })) {
      uris.push(meta.uri);
    }
    // top.md is outside the prefix; skipme/ pruned; deeper/ is beyond maxDepth
    // so d3.md is never reached (d1.md at depth 0 is the only survivor... and
    // files directly inside deep/ would be at depth 1 — none exist here).
    expect(uris).toEqual([formatArtifactUri({ rootId: 'workspace', relPath: 'docs/d1.md' })]);
  });

  it('throws not-found for a missing walk root', async () => {
    const p = new FilesystemStorageProvider('ghost', join(tempDir, 'does-not-exist'));
    const iterate = async () => {
      for await (const meta of p.list()) void meta;
    };
    await expect(iterate()).rejects.toMatchObject({ kind: 'not-found' });
  });
});
