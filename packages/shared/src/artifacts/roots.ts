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

import { realpathSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import type {
  ArtifactRootsConfig,
  RootBindingConfig,
  RootHealth,
  StorageCapabilities,
} from '@craft-agent/core/types';
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
 * Single variant today (filesystem). Storage-provider kinds (object storage
 * etc.) slot in additively through `createRootBinding` — the provider factory
 * seam (ADR-0019 §1) — per the ADR-0016 storage-separation goal. No second
 * backend is implemented here (PLAN-029 non-goal).
 */
export type RootBinding = { kind: 'filesystem'; path: string };

/**
 * Normalize a persisted `artifactRoots` value into a `RootBindingConfig`
 * (ADR-0019 §1). A bare `string` is the filesystem shorthand; an object with a
 * string `kind` passes through; anything else is rejected (`null`). Pure — no
 * fs access, no absolute-path check (that lives in the factory per-kind).
 */
export function normalizeRootConfig(value: unknown): RootBindingConfig | null {
  if (typeof value === 'string') {
    return { kind: 'filesystem', path: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) {
      return value as RootBindingConfig;
    }
  }
  return null;
}

/**
 * Provider factory (ADR-0019 §1) — the single registration point where a future
 * kind plugs in. Dispatches on `cfg.kind` and returns a `RootBinding`, or `null`
 * for an invalid/unknown kind (skipped-and-logged at resolution, never thrown).
 *
 * A future object-store backend is one `case`:
 *   case 'object-store': return new ObjectStoreProvider(rootId, cfg) ...
 * touching only this factory, not `resolveRootBindings` control flow. No second
 * backend is built here (PLAN-029 non-goal); unknown/prefixed kinds fall
 * through to the tolerant default.
 */
export function createRootBinding(rootId: string, cfg: RootBindingConfig): RootBinding | null {
  switch (cfg.kind) {
    case 'filesystem': {
      const path = (cfg as { path?: unknown }).path;
      if (typeof path !== 'string' || !isAbsolute(path)) {
        debug('[artifacts] Skipping filesystem root with non-absolute path:', rootId, path);
        return null;
      }
      return { kind: 'filesystem', path };
    }
    default:
      // Forward-tolerant: unknown/prefixed kinds (e.g. a newer config's
      // 'object-store') are skipped so a newer config never bricks an older
      // Vorno. Secret-bearing kinds route to the ADR-0013 vault (ADR-0019 §4).
      debug('[artifacts] Skipping root with unsupported kind:', rootId, cfg.kind);
      return null;
  }
}

/**
 * Declared capabilities for a provider kind (ADR-0019 §3). The provider is the
 * authority — config never asserts capabilities. C2 is read-only across all
 * kinds; `write`/`presign` land with a real write path.
 */
export function capabilitiesForKind(kind: string): StorageCapabilities {
  switch (kind) {
    case 'filesystem':
      return { read: true, list: true, write: false, presign: false };
    default:
      return { read: false, list: false, write: false, presign: false };
  }
}

/**
 * Bounded root-level health probe (ADR-0019 §3). Stats the root once: missing
 * path → `'missing'`, not a directory / stat error → `'unreadable'`, else
 * `'ok'`. `'truncated'` is a scan-time concept (index cap), not a root probe —
 * it stays reachable via `ArtifactSkippedRoot`. Never throws.
 */
export function probeRootHealth(binding: RootBinding): RootHealth {
  if (binding.kind !== 'filesystem') return 'unreadable';
  try {
    const st = statSync(binding.path);
    return st.isDirectory() ? 'ok' : 'unreadable';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/**
 * Resolve the effective root bindings for a workspace. The `workspace` root is
 * always present (bound to `workspaceRootPath`). Configured entries are
 * normalized (`string` → filesystem shorthand), validated (id regex, must not be
 * the reserved `workspace` id), then dispatched through the provider factory
 * (`createRootBinding`); invalid/unknown entries are skipped and debug-logged,
 * never thrown. Accepts the widened `ArtifactRootsConfig` value union — old
 * `Record<string, string>` configs are a subset (ADR-0019 §1, zero migration).
 */
export function resolveRootBindings(
  workspaceRootPath: string,
  configuredRoots?: ArtifactRootsConfig,
): Map<string, RootBinding> {
  const bindings = new Map<string, RootBinding>();
  bindings.set(RESERVED_WORKSPACE_ROOT_ID, { kind: 'filesystem', path: workspaceRootPath });

  if (configuredRoots) {
    for (const [rootId, rawValue] of Object.entries(configuredRoots)) {
      if (rootId === RESERVED_WORKSPACE_ROOT_ID) {
        debug('[artifacts] Skipping configured root that shadows reserved id:', rootId);
        continue;
      }
      if (!isValidRootId(rootId)) {
        debug('[artifacts] Skipping configured root with invalid id:', rootId);
        continue;
      }
      const cfg = normalizeRootConfig(rawValue);
      if (!cfg) {
        debug('[artifacts] Skipping configured root with unparseable value:', rootId, rawValue);
        continue;
      }
      const binding = createRootBinding(rootId, cfg);
      if (!binding) continue; // factory already logged the reason
      bindings.set(rootId, binding);
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
