/**
 * Root registry + containment (ADR-0016 §2).
 *
 * Root bindings (`rootId → absolute path`) are the artifact-plane trust
 * boundary. They live in workspace config, never on the wire. The `workspace`
 * root always exists (zero-config); additional roots are the advanced override.
 *
 * Containment is the proven realpath + segment-guard check carried over from the
 * workbench (`workbench/artifacts.ts:resolveContainedArtifact`): resolve a URI's
 * relPath under its bound root, realpath both sides, and require the target to
 * sit inside the realpathed root. Symlink escapes, dot-collapse, and
 * sibling-prefix attacks are all rejected by construction.
 */

import { realpathSync } from 'fs';
import { isAbsolute, join } from 'path';
import { debug } from '../utils/debug.ts';
import {
  RESERVED_WORKSPACE_ROOT_ID,
  formatArtifactUri,
  isValidRootId,
  parseArtifactUri,
} from './uri.ts';

/**
 * How a root id resolves to bytes.
 *
 * // ponytail: single variant; storage-provider kinds (object storage etc.) slot
 * // in additively per ADR-0016 storage-separation goal.
 */
export type RootBinding = { kind: 'filesystem'; path: string };

/**
 * Resolve the effective root bindings for a workspace. The `workspace` root is
 * always present (bound to `workspaceRootPath`). Configured entries are
 * validated (id regex, must not be the reserved `workspace` id, value must be an
 * absolute path); invalid entries are skipped and debug-logged, never thrown.
 */
export function resolveRootBindings(
  workspaceRootPath: string,
  configuredRoots?: Record<string, string>,
): Map<string, RootBinding> {
  const bindings = new Map<string, RootBinding>();
  bindings.set(RESERVED_WORKSPACE_ROOT_ID, { kind: 'filesystem', path: workspaceRootPath });

  if (configuredRoots) {
    for (const [rootId, path] of Object.entries(configuredRoots)) {
      if (rootId === RESERVED_WORKSPACE_ROOT_ID) {
        debug('[artifacts] Skipping configured root that shadows reserved id:', rootId);
        continue;
      }
      if (!isValidRootId(rootId)) {
        debug('[artifacts] Skipping configured root with invalid id:', rootId);
        continue;
      }
      if (typeof path !== 'string' || !isAbsolute(path)) {
        debug('[artifacts] Skipping configured root with non-absolute path:', rootId, path);
        continue;
      }
      bindings.set(rootId, { kind: 'filesystem', path });
    }
  }

  return bindings;
}

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
 * realpathed already. Uses a path-segment guard so `/a/roots` is not treated as
 * inside `/a/root`.
 */
function isInside(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true;
  const withSep = realRoot.endsWith('/') ? realRoot : realRoot + '/';
  return realTarget.startsWith(withSep);
}

/**
 * Resolve a `vorno-artifact://` URI to an absolute filesystem path, enforcing
 * containment against its bound root. Returns null on any failure: bad URI,
 * unknown root, non-filesystem binding, or a target that (after realpath)
 * escapes the realpathed root. Both the target and the root are realpathed so
 * symlink escapes are caught.
 */
export function resolveArtifactPath(
  uri: string,
  bindings: Map<string, RootBinding>,
): { absPath: string } | null {
  const parsed = parseArtifactUri(uri);
  if (!parsed) return null;

  const binding = bindings.get(parsed.rootId);
  if (!binding || binding.kind !== 'filesystem') return null;

  const realRoot = tryRealpath(binding.path);
  if (!realRoot) return null;

  const candidate = join(binding.path, parsed.relPath);
  const realTarget = tryRealpath(candidate);
  if (!realTarget) return null;

  if (!isInside(realRoot, realTarget)) return null;
  return { absPath: realTarget };
}

/**
 * Reverse mapping: find the `vorno-artifact://` URI for an absolute path.
 * Longest-matching binding wins (so a nested root beats `workspace`). Used by
 * the scanner (to stamp URIs onto scanned files) and by legacy absolute-path
 * resolution. Returns null when the path is inside no bound root. Uses realpath
 * on both sides for a stable, symlink-normalized comparison.
 */
export function absPathToUri(
  absPath: string,
  bindings: Map<string, RootBinding>,
): string | null {
  const realTarget = tryRealpath(absPath);
  if (!realTarget) return null;

  let best: { rootId: string; realRoot: string } | null = null;
  for (const [rootId, binding] of bindings) {
    if (binding.kind !== 'filesystem') continue;
    const realRoot = tryRealpath(binding.path);
    if (!realRoot) continue;
    if (!isInside(realRoot, realTarget)) continue;
    if (!best || realRoot.length > best.realRoot.length) {
      best = { rootId, realRoot };
    }
  }
  if (!best) return null;

  // relPath is the portion of realTarget below its bound root, POSIX-joined.
  let rel = realTarget.slice(best.realRoot.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  // The root itself has no relPath — not addressable as an artifact.
  if (rel.length === 0) return null;

  // Build the URI directly (rel is already realpath-clean, POSIX-separated).
  return formatArtifactUri({ rootId: best.rootId, relPath: rel });
}
