/**
 * Root registry (ADR-0016 §2, ADR-0018).
 *
 * Root bindings (`rootId → provider`) are the artifact-plane trust boundary.
 * Binding config lives in workspace settings, never on the wire. The
 * `workspace` root always exists (zero-config); additional roots are the
 * advanced override.
 *
 * Since ADR-0018 a binding resolves to a `StorageProvider`, which owns all
 * I/O and containment — no absolute path leaves the provider. A future
 * object-store root kind constructs a different provider behind the same map;
 * consumers only ever call `provider.*`.
 */

import { isAbsolute } from 'path';
import { debug } from '../utils/debug.ts';
import { RESERVED_WORKSPACE_ROOT_ID, isValidRootId } from './uri.ts';
import { FilesystemStorageProvider } from './storage/filesystem.ts';
import { StorageOpError, type StorageProvider } from './storage/provider.ts';
import type {
  ArtifactRootsConfig,
  RootBindingConfig,
  RootHealth,
} from '@craft-agent/core/types';

/**
 * Normalize a persisted root-config value to a `RootBindingConfig` (ADR-0019
 * §1). A bare `string` is the filesystem shorthand (`{ kind: 'filesystem',
 * path }`); an object with a string `kind` passes through; anything else is
 * malformed and returns `null` (caller skips + debug-logs, never throws).
 */
export function normalizeRootConfig(
  value: string | RootBindingConfig,
): RootBindingConfig | null {
  if (typeof value === 'string') return { kind: 'filesystem', path: value };
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { kind?: unknown }).kind === 'string'
  ) {
    return value;
  }
  return null;
}

/**
 * Provider factory — the single plug-in point where a future storage kind is
 * registered (ADR-0018 §1, ADR-0019 §1). Adding a backend adds one `case` here
 * and one `RootBindingConfig` variant, touching neither `resolveRootBindings`
 * control flow nor any consumer. Unknown/invalid kinds return `null` (skipped +
 * debug-logged at resolution), so a newer config never bricks an older Vorno.
 */
export function createProvider(
  rootId: string,
  cfg: RootBindingConfig,
): StorageProvider | null {
  switch (cfg.kind) {
    case 'filesystem': {
      const path = (cfg as { path?: unknown }).path;
      if (typeof path !== 'string' || !isAbsolute(path)) {
        debug('[artifacts] Skipping filesystem root with non-absolute path:', rootId, path);
        return null;
      }
      return new FilesystemStorageProvider(rootId, path);
    }
    // case 'object-store': return new ObjectStoreProvider(rootId, cfg)  // hosted track (ADR-0013 / PLAN-023)
    default:
      debug('[artifacts] Skipping root with unsupported kind:', rootId, cfg.kind);
      return null;
  }
}

/**
 * Resolve the effective root bindings for a workspace. The `workspace` root is
 * always present (bound to `workspaceRootPath`). Each configured value is
 * normalized (string → filesystem) and dispatched through `createProvider`;
 * entries that shadow the reserved id, carry an invalid id, or fail to build a
 * provider are skipped and debug-logged, never thrown.
 */
export function resolveRootBindings(
  workspaceRootPath: string,
  configuredRoots?: ArtifactRootsConfig,
): Map<string, StorageProvider> {
  const providers = new Map<string, StorageProvider>();
  providers.set(
    RESERVED_WORKSPACE_ROOT_ID,
    new FilesystemStorageProvider(RESERVED_WORKSPACE_ROOT_ID, workspaceRootPath),
  );

  if (configuredRoots) {
    for (const [rootId, value] of Object.entries(configuredRoots)) {
      if (rootId === RESERVED_WORKSPACE_ROOT_ID) {
        debug('[artifacts] Skipping configured root that shadows reserved id:', rootId);
        continue;
      }
      if (!isValidRootId(rootId)) {
        debug('[artifacts] Skipping configured root with invalid id:', rootId);
        continue;
      }
      const cfg = normalizeRootConfig(value);
      if (!cfg) {
        debug('[artifacts] Skipping configured root with malformed config:', rootId);
        continue;
      }
      const provider = createProvider(rootId, cfg);
      if (provider) providers.set(rootId, provider);
    }
  }

  return providers;
}

/**
 * Bounded per-root health probe (ADR-0019 §4). Storage-agnostic: it kicks the
 * provider's `list` iterator once, which reads only the root's top directory
 * before the first yield, then stops. A missing root surfaces as `not-found`,
 * an unreadable one as `io` (mapped to the `ArtifactSkippedRoot` vocabulary +
 * `ok`). No absolute path is ever produced. `truncated` is a scan-cap concept
 * this probe does not raise.
 */
export async function probeRootHealth(provider: StorageProvider): Promise<RootHealth> {
  const iterator = provider.list({ maxDepth: 0 })[Symbol.asyncIterator]();
  try {
    await iterator.next();
    await iterator.return?.(undefined);
    return 'ok';
  } catch (error) {
    if (error instanceof StorageOpError) {
      return error.kind === 'not-found' ? 'missing' : 'unreadable';
    }
    debug('[artifacts] Root health probe failed:', provider.kind, error);
    return 'unreadable';
  }
}
