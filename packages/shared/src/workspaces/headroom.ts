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

import {
  resolveHeadroomConfig,
  resolveHeadroomConfigSources,
} from '@craft-agent/core/types';
import type {
  HeadroomConfig,
  HeadroomConfigOverrides,
  HeadroomConfigSources,
} from '@craft-agent/core/types';
import { getHeadroomInstanceConfig } from '../config/storage.ts';
import { loadWorkspaceConfig } from './storage.ts';

/**
 * Read both persisted layers, exactly as stored (unvalidated — the resolver
 * owns validation). Neither read throws: a missing or unreadable file is
 * indistinguishable from "no headroom key", and both resolve to disabled.
 */
function readHeadroomLayers(workspaceRootPath?: string): {
  instance: unknown;
  workspace: unknown;
} {
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

  return { instance, workspace };
}

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
  const { instance, workspace } = readHeadroomLayers(workspaceRootPath);
  return resolveHeadroomConfig(instance, workspace);
}

/**
 * Everything an editing surface needs about one workspace's Headroom config
 * (fork: PLAN-040, SUV-0017).
 *
 * `instanceEffective` is the answer to "what would this workspace get if I
 * cleared every override?" — i.e. the instance base resolved against the
 * disabled defaults. That is the value a cleared field reverts to, so a UI can
 * show it without knowing how the two lower layers combine.
 */
export interface HeadroomConfigView {
  /** Resolved config: workspace → instance → defaults. */
  effective: HeadroomConfig;
  /** Resolved config with the workspace layer removed. */
  instanceEffective: HeadroomConfig;
  /**
   * The workspace layer exactly as stored, or `undefined` when absent.
   *
   * Deliberately raw rather than sanitized: an editor reads this, changes one
   * field, and writes the whole object back, so sanitizing here would silently
   * drop keys written by a newer build — the exact forward-compatibility the
   * SUV-0016 layer validator goes out of its way to preserve. Never read it
   * for precedence; use `sources` and `effective`, which are validated.
   */
  overrides: HeadroomConfigOverrides | undefined;
  /** Per-field provenance, matching `effective` field for field. */
  sources: HeadroomConfigSources;
}

/**
 * Load the full editing view of a workspace's Headroom config.
 *
 * Pure read: resolution, validation, and provenance all come from the
 * `@craft-agent/core/types` resolver, so a caller (the workspace settings UI)
 * holds no precedence logic of its own. Does not throw.
 *
 * @param workspaceRootPath Absolute path to the workspace root. Omit to view
 *   the instance base alone, in which case no field can report a `workspace`
 *   source.
 */
export function loadHeadroomConfigView(workspaceRootPath?: string): HeadroomConfigView {
  const { instance, workspace } = readHeadroomLayers(workspaceRootPath);

  return {
    effective: resolveHeadroomConfig(instance, workspace),
    instanceEffective: resolveHeadroomConfig(instance, undefined),
    overrides: (workspace ?? undefined) as HeadroomConfigOverrides | undefined,
    sources: resolveHeadroomConfigSources(instance, workspace),
  };
}
