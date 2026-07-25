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
import type { StorageProvider } from './storage/provider.ts';

/**
 * Resolve the effective root bindings for a workspace. The `workspace` root is
 * always present (bound to `workspaceRootPath`). Configured entries are
 * validated (id regex, must not be the reserved `workspace` id, value must be
 * an absolute path); invalid entries are skipped and debug-logged, never
 * thrown.
 */
export function resolveRootBindings(
  workspaceRootPath: string,
  configuredRoots?: Record<string, string>,
): Map<string, StorageProvider> {
  const providers = new Map<string, StorageProvider>();
  providers.set(
    RESERVED_WORKSPACE_ROOT_ID,
    new FilesystemStorageProvider(RESERVED_WORKSPACE_ROOT_ID, workspaceRootPath),
  );

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
      providers.set(rootId, new FilesystemStorageProvider(rootId, path));
    }
  }

  return providers;
}
