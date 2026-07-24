import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveRootBindings,
  resolveArtifactPath,
  absPathToUri,
  normalizeRootConfig,
  createRootBinding,
  capabilitiesForKind,
  probeRootHealth,
} from '../roots.ts';
import { formatArtifactUri } from '../uri.ts';

let tempDir: string;
let workspaceRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'artifacts-roots-test-'));
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
  it('always includes the workspace root', () => {
    const b = resolveRootBindings(workspaceRoot);
    expect(b.get('workspace')).toEqual({ kind: 'filesystem', path: workspaceRoot });
  });

  it('validates configured roots (id regex, absolute path, not workspace)', () => {
    const roadmap = join(tempDir, 'roadmap');
    const b = resolveRootBindings(workspaceRoot, {
      roadmap,
      workspace: '/somewhere', // shadows reserved id → skipped
      Bad: '/x', // invalid id → skipped
      rel: 'relative/path', // not absolute → skipped
    });
    expect(b.get('roadmap')).toEqual({ kind: 'filesystem', path: roadmap });
    expect(b.get('workspace')).toEqual({ kind: 'filesystem', path: workspaceRoot });
    expect(b.has('Bad')).toBe(false);
    expect(b.has('rel')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config schema widening + provider factory seam (ADR-0019, PLAN-029)
// ---------------------------------------------------------------------------

describe('normalizeRootConfig', () => {
  it('reads a bare string as the filesystem shorthand', () => {
    expect(normalizeRootConfig('/abs/path')).toEqual({ kind: 'filesystem', path: '/abs/path' });
  });

  it('passes through an object with a string kind', () => {
    expect(normalizeRootConfig({ kind: 'filesystem', path: '/x' })).toEqual({
      kind: 'filesystem',
      path: '/x',
    });
    // Unknown/prefixed kind still parses (tolerant) — rejection is at the factory.
    expect(normalizeRootConfig({ kind: 'object-store', bucket: 'b' })).toEqual({
      kind: 'object-store',
      bucket: 'b',
    });
  });

  it('rejects values with no string kind', () => {
    expect(normalizeRootConfig(null)).toBeNull();
    expect(normalizeRootConfig(42)).toBeNull();
    expect(normalizeRootConfig([])).toBeNull();
    expect(normalizeRootConfig({})).toBeNull();
    expect(normalizeRootConfig({ kind: 123 })).toBeNull();
    expect(normalizeRootConfig({ kind: '' })).toBeNull();
  });
});

describe('createRootBinding (provider factory)', () => {
  it('builds a filesystem binding from an absolute path', () => {
    expect(createRootBinding('r', { kind: 'filesystem', path: '/abs' })).toEqual({
      kind: 'filesystem',
      path: '/abs',
    });
  });

  it('skips a filesystem binding with a non-absolute path', () => {
    expect(createRootBinding('r', { kind: 'filesystem', path: 'rel' })).toBeNull();
    expect(createRootBinding('r', { kind: 'filesystem' } as never)).toBeNull();
  });

  it('skips an unknown/unsupported kind (no second backend in C2), never throws', () => {
    expect(createRootBinding('r', { kind: 'object-store', bucket: 'b' })).toBeNull();
    expect(createRootBinding('r', { kind: 'acme:widgets' })).toBeNull();
  });
});

describe('resolveRootBindings — widened value union (ADR-0019 §1)', () => {
  it('treats a string value identically to the filesystem object form', () => {
    const dir = join(tempDir, 'corpus');
    const fromString = resolveRootBindings(workspaceRoot, { corpus: dir });
    const fromObject = resolveRootBindings(workspaceRoot, {
      corpus: { kind: 'filesystem', path: dir },
    });
    expect(fromString.get('corpus')).toEqual({ kind: 'filesystem', path: dir });
    expect(fromObject.get('corpus')).toEqual(fromString.get('corpus'));
  });

  it('skips an unknown-kind object at resolution (forward-tolerant)', () => {
    const b = resolveRootBindings(workspaceRoot, {
      later: { kind: 'object-store', bucket: 'b' },
      good: { kind: 'filesystem', path: join(tempDir, 'g') },
    });
    expect(b.has('later')).toBe(false);
    expect(b.get('good')).toEqual({ kind: 'filesystem', path: join(tempDir, 'g') });
  });

  it('skips a filesystem object with a non-absolute path', () => {
    const b = resolveRootBindings(workspaceRoot, {
      bad: { kind: 'filesystem', path: 'relative' },
    });
    expect(b.has('bad')).toBe(false);
  });
});

describe('capabilitiesForKind', () => {
  it('reports filesystem as read-only (C2: no write path)', () => {
    expect(capabilitiesForKind('filesystem')).toEqual({
      read: true,
      list: true,
      write: false,
      presign: false,
    });
  });

  it('reports no capabilities for an unknown kind', () => {
    expect(capabilitiesForKind('object-store')).toEqual({
      read: false,
      list: false,
      write: false,
      presign: false,
    });
  });
});

describe('probeRootHealth', () => {
  it('reports ok for an existing directory root', () => {
    expect(probeRootHealth({ kind: 'filesystem', path: workspaceRoot })).toBe('ok');
  });

  it('reports missing for a non-existent path', () => {
    expect(probeRootHealth({ kind: 'filesystem', path: join(tempDir, 'nope') })).toBe('missing');
  });

  it('reports unreadable when the path is a file, not a directory', () => {
    const f = write(join(tempDir, 'file-root.md'), '# f');
    expect(probeRootHealth({ kind: 'filesystem', path: f })).toBe('unreadable');
  });
});

describe('roots:list payload shape (ADR-0016 §2 + ADR-0019 §3)', () => {
  // Mirrors the ROOTS_LIST handler mapping exactly: id + kind + capabilities +
  // status, with absolute paths NEVER present on the wire.
  it('emits id/kind/capabilities/status and never leaks an absolute path', () => {
    const corpus = join(tempDir, 'corpus');
    mkdirSync(corpus, { recursive: true });
    const bindings = resolveRootBindings(workspaceRoot, { corpus });
    const payload = Array.from(bindings.entries()).map(([id, binding]) => ({
      id,
      kind: binding.kind,
      capabilities: capabilitiesForKind(binding.kind),
      status: probeRootHealth(binding),
    }));

    const workspaceEntry = payload.find((r) => r.id === 'workspace');
    const corpusEntry = payload.find((r) => r.id === 'corpus');
    expect(workspaceEntry).toEqual({
      id: 'workspace',
      kind: 'filesystem',
      capabilities: { read: true, list: true, write: false, presign: false },
      status: 'ok',
    });
    expect(corpusEntry?.status).toBe('ok');

    // No entry carries a `path` (or any absolute-path string) — ADR-0016 §2.
    for (const entry of payload) {
      expect(entry).not.toHaveProperty('path');
      const serialized = JSON.stringify(entry);
      expect(serialized.includes(workspaceRoot)).toBe(false);
      expect(serialized.includes(corpus)).toBe(false);
    }
  });

  it('surfaces missing health for a configured root whose path is gone', () => {
    const gone = join(tempDir, 'ghost-root');
    const bindings = resolveRootBindings(workspaceRoot, { ghost: gone });
    const ghost = bindings.get('ghost');
    expect(ghost).toBeDefined();
    expect(probeRootHealth(ghost!)).toBe('missing');
  });
});

describe('resolveArtifactPath containment', () => {
  it('resolves an in-root URI to its realpath', () => {
    const file = write(join(workspaceRoot, 'sessions', 's1', 'plans', 'p.md'), '# p');
    const b = resolveRootBindings(workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/plans/p.md' });
    const resolved = resolveArtifactPath(uri, b);
    expect(resolved?.absPath).toBe(require('fs').realpathSync(file));
  });

  it('rejects a path outside the bound root (dotdot cannot even be expressed)', () => {
    write(join(workspaceRoot, 'in.md'), '# in');
    write(join(tempDir, 'outside.md'), '# out');
    const b = resolveRootBindings(workspaceRoot);
    // dotdot is parse-rejected at the URI layer, so containment is belt+braces.
    expect(resolveArtifactPath('vorno-artifact://workspace/../outside.md', b)).toBeNull();
  });

  it('rejects a symlink leaf that escapes the root', () => {
    const secret = write(join(tempDir, 'secret.md'), '# secret');
    const linkPath = join(workspaceRoot, 'link.md');
    symlinkSync(secret, linkPath);
    const b = resolveRootBindings(workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'link.md' });
    expect(resolveArtifactPath(uri, b)).toBeNull();
  });

  it('rejects a symlinked directory that escapes the root', () => {
    const secretDir = join(tempDir, 'secretdir');
    write(join(secretDir, 'x.md'), '# x');
    const linkDir = join(workspaceRoot, 'linkdir');
    symlinkSync(secretDir, linkDir);
    const b = resolveRootBindings(workspaceRoot);
    const uri = formatArtifactUri({ rootId: 'workspace', relPath: 'linkdir/x.md' });
    expect(resolveArtifactPath(uri, b)).toBeNull();
  });

  it('does not treat a sibling prefix dir as contained', () => {
    // root = <tmp>/root, sibling = <tmp>/root-evil — segment guard must reject.
    const root = join(tempDir, 'root');
    write(join(root, 'a.md'), '# a');
    write(join(tempDir, 'root-evil', 'y.md'), '# y');
    const b = resolveRootBindings(workspaceRoot, { root });
    // Address the sibling via the root binding — its realpath is outside.
    // (Can't express via relPath directly; use absPathToUri to confirm the
    // sibling maps to no root.)
    expect(absPathToUri(join(tempDir, 'root-evil', 'y.md'), b)).toBeNull();
    // And the legitimate one resolves.
    const uri = formatArtifactUri({ rootId: 'root', relPath: 'a.md' });
    expect(resolveArtifactPath(uri, b)).not.toBeNull();
  });

  it('returns null for an unknown root id', () => {
    const b = resolveRootBindings(workspaceRoot);
    expect(resolveArtifactPath('vorno-artifact://ghost/a.md', b)).toBeNull();
  });
});

describe('absPathToUri', () => {
  it('maps an in-workspace path to a workspace URI', () => {
    const file = write(join(workspaceRoot, 'sessions', 's1', 'data', 'o.md'), '# o');
    const b = resolveRootBindings(workspaceRoot);
    expect(absPathToUri(file, b)).toBe(
      formatArtifactUri({ rootId: 'workspace', relPath: 'sessions/s1/data/o.md' }),
    );
  });

  it('longest-match binding wins (nested root beats workspace)', () => {
    // roadmap lives inside the workspace; a file under it should map to roadmap.
    const roadmap = join(workspaceRoot, 'roadmap');
    const file = write(join(roadmap, 'decisions', 'adr.md'), '# adr');
    const b = resolveRootBindings(workspaceRoot, { roadmap });
    expect(absPathToUri(file, b)).toBe(
      formatArtifactUri({ rootId: 'roadmap', relPath: 'decisions/adr.md' }),
    );
  });

  it('returns null for a path inside no root', () => {
    const file = write(join(tempDir, 'loose.md'), '# loose');
    const b = resolveRootBindings(workspaceRoot);
    expect(absPathToUri(file, b)).toBeNull();
  });

  it('returns null for the root dir itself (no relPath)', () => {
    const b = resolveRootBindings(workspaceRoot);
    expect(absPathToUri(workspaceRoot, b)).toBeNull();
  });
});
