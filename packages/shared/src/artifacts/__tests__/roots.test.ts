import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveRootBindings,
  resolveArtifactPath,
  absPathToUri,
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
