/**
 * Headroom config storage glue (fork: PLAN-040, SUV-0016).
 *
 * Reads the two persisted layers through the existing config machinery and
 * hands them to the pure resolver in `@craft-agent/core/types`:
 *
 *   - instance base  — config-root `config.json`, key `headroom`
 *   - workspace over — workspace `config.json`, key `defaults.headroom`
 *
 * Lives under `workspaces/` rather than `config/` because it is workspace-
 * scoped and `workspaces/storage.ts` already depends on `config/storage.ts`;
 * the reverse edge would invert the layering.
 *
 * Nothing consumes the result yet — wiring it into the boundary adapter is
 * SUV-0018, and any UI is SUV-0017.
 */

import { resolveHeadroomConfig } from '@craft-agent/core/types';
import type { HeadroomConfig } from '@craft-agent/core/types';
import { getHeadroomInstanceConfig } from '../config/storage.ts';
import { loadWorkspaceConfig } from './storage.ts';

/**
 * Load and resolve the effective Headroom config for a workspace.
 *
 * A fresh install — no config-root `config.json`, no workspace `config.json`,
 * or neither carrying a `headroom` key — resolves to the disabled default.
 * Malformed layers are discarded by the resolver rather than thrown; this
 * function does not throw.
 *
 * @param workspaceRootPath Absolute path to the workspace root. Omit to
 *   resolve the instance base alone (e.g. before a workspace is selected).
 */
export function loadEffectiveHeadroomConfig(workspaceRootPath?: string): HeadroomConfig {
  let instance: unknown;
  try {
    instance = getHeadroomInstanceConfig();
  } catch {
    instance = undefined;
  }

  let workspace: unknown;
  if (workspaceRootPath) {
    try {
      workspace = loadWorkspaceConfig(workspaceRootPath)?.defaults?.headroom;
    } catch {
      workspace = undefined;
    }
  }

  return resolveHeadroomConfig(instance, workspace);
}
