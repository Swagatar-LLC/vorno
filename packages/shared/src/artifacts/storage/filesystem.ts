/**
 * FilesystemStorageProvider (ADR-0018).
 *
 * Owns the proven realpath + segment-guard containment carried over from
 * roots.ts (originally workbench `resolveContainedArtifact`): resolve a URI's
 * relPath under the bound root, realpath both sides, and require the target to
 * sit inside the realpathed root. Symlink escapes, dot-collapse, and
 * sibling-prefix attacks are rejected by construction. The absolute path never
 * leaves this class (ADR-0018 door 2).
 *
 * `list` walks with Dirent (lstat) semantics — symlinks are never followed,
 * matching the C1 scanner — so walk-constructed relPaths cannot escape the
 * root and need no per-entry realpath.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import type { StorageCapabilities } from '@craft-agent/core/types';
import { formatArtifactUri, parseArtifactUri } from '../uri.ts';
import { getGitSha } from '../content.ts';
import { debug } from '../../utils/debug.ts';
import {
  StorageOpError,
  err,
  ok,
  type ArtifactMeta,
  type ListOpts,
  type ReadOpts,
  type Result,
  type StorageProvider,
} from './provider.ts';

/** Realpath a path, returning null when it does not resolve (missing/broken). */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `realTarget` is inside `realRoot` (or equal to it). Both must be
 * realpathed already. Path-segment guard: `/a/roots` is not inside `/a/root`.
 */
function isInside(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true;
  const withSep = realRoot.endsWith('/') ? realRoot : realRoot + '/';
  return realTarget.startsWith(withSep);
}

export class FilesystemStorageProvider implements StorageProvider {
  readonly kind = 'filesystem';
  readonly capabilities: StorageCapabilities = {
    read: true,
    stat: true,
    list: true,
    contentHash: true,
    write: false,
    delete: false,
    copy: false,
    presign: false,
  };

  constructor(
    readonly rootId: string,
    private readonly rootPath: string,
  ) {}

  /**
   * URI → contained absolute path, or null on any failure: bad URI, foreign
   * rootId, or a target that (after realpath) escapes the realpathed root.
   * Private — the resolved path never leaves this class.
   */
  private resolve(uri: string): { absPath: string; canonicalUri: string } | null {
    const parsed = parseArtifactUri(uri);
    if (!parsed) return null;
    if (parsed.rootId !== this.rootId) return null;

    const realRoot = tryRealpath(this.rootPath);
    if (!realRoot) return null;

    const realTarget = tryRealpath(join(this.rootPath, parsed.relPath));
    if (!realTarget) return null;

    if (!isInside(realRoot, realTarget)) return null;
    return { absPath: realTarget, canonicalUri: formatArtifactUri(parsed) };
  }

  async stat(uri: string): Promise<Result<ArtifactMeta>> {
    const resolved = this.resolve(uri);
    if (!resolved) return err('not-found');
    try {
      const stats = statSync(resolved.absPath);
      return ok({
        uri: resolved.canonicalUri,
        type: stats.isDirectory() ? 'dir' : 'file',
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      return err('not-found');
    }
  }

  async read(
    uri: string,
    opts?: ReadOpts,
  ): Promise<Result<{ bytes: Buffer; meta: ArtifactMeta }>> {
    const resolved = this.resolve(uri);
    if (!resolved) return err('not-found');
    try {
      const stats = statSync(resolved.absPath);
      if (!stats.isFile()) return err('not-found');
      if (opts?.maxBytes !== undefined && stats.size > opts.maxBytes) return err('too-large');
      const bytes = readFileSync(resolved.absPath);
      const meta: ArtifactMeta = {
        uri: resolved.canonicalUri,
        type: 'file',
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        // Hash the buffer we already hold — no second file read (PERF-2).
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      };
      if (opts?.withVersion) {
        const dirEnd = resolved.absPath.lastIndexOf('/');
        meta.gitSha = await getGitSha(resolved.absPath.slice(0, Math.max(dirEnd, 1)));
      }
      return ok({ bytes, meta });
    } catch (error) {
      debug('[artifacts] Filesystem read failed:', uri, error);
      return err('io');
    }
  }

  async *list(opts?: ListOpts): AsyncIterable<ArtifactMeta> {
    const prefixSegments = opts?.prefix ? opts.prefix.split('/') : [];
    const startDir = join(this.rootPath, ...prefixSegments);
    const maxDepth = opts?.maxDepth ?? Infinity;

    // Missing vs unreadable root distinction rides the thrown kind.
    let top: import('fs').Dirent[];
    try {
      top = readdirSync(startDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new StorageOpError(code === 'ENOENT' ? 'not-found' : 'io', String(error));
    }

    yield* this.walk(top, startDir, prefixSegments, 0, maxDepth, opts?.skipDir);
  }

  private *walk(
    entries: import('fs').Dirent[],
    dir: string,
    segments: string[],
    depth: number,
    maxDepth: number,
    skipDir?: (relPath: string) => boolean,
  ): Generator<ArtifactMeta> {
    for (const entry of entries) {
      const name = entry.name;
      const relSegments = [...segments, name];
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        if (skipDir?.(relSegments.join('/'))) continue;
        const childDir = join(dir, name);
        let children: import('fs').Dirent[];
        try {
          children = readdirSync(childDir, { withFileTypes: true });
        } catch (error) {
          debug('[artifacts] Skipping unreadable dir:', childDir, error);
          continue;
        }
        yield* this.walk(children, childDir, relSegments, depth + 1, maxDepth, skipDir);
      } else if (entry.isFile()) {
        let stats: import('fs').Stats;
        try {
          stats = statSync(join(dir, name));
        } catch {
          continue;
        }
        yield {
          uri: formatArtifactUri({ rootId: this.rootId, relPath: relSegments.join('/') }),
          type: 'file',
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      }
      // Symlinks (isSymbolicLink) fall through both branches — never followed.
    }
  }

  async exists(uri: string): Promise<boolean> {
    const resolved = this.resolve(uri);
    if (!resolved) return false;
    try {
      statSync(resolved.absPath);
      return true;
    } catch {
      return false;
    }
  }
}
