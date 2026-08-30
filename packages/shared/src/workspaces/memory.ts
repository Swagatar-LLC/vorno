/**
 * Memory config storage glue (fork: PLAN-040, SUV-0029; ADR-0031).
 *
 * Reads the two persisted layers through the existing config machinery and
 * hands them to the pure resolver in `@craft-agent/core/types`:
 *
 *   - instance base  — config-root `config.json`, key `memory`
 *   - workspace over — workspace `config.json`, key `defaults.memory`
 *
 * A deliberate near-copy of `headroom.ts`. Two config sections in one product
 * that resolve their layers differently is a bug the day someone has to
 * explain why a workspace override behaves one way for compression and another
 * for memory; the duplication is the cheaper of the two.
 *
 * Lives under `workspaces/` rather than `config/` for the same layering reason:
 * `workspaces/storage.ts` already depends on `config/storage.ts`, and the
 * reverse edge would invert it.
 */

import { resolveMemoryConfig, resolveMemoryConfigSources } from '@craft-agent/core/types';
import type {
  MemoryConfig,
  MemoryConfigOverrides,
  MemoryConfigSources,
} from '@craft-agent/core/types';
import { getMemoryInstanceConfig } from '../config/storage.ts';
import { loadWorkspaceConfig } from './storage.ts';

/**
 * Read both persisted layers exactly as stored — unvalidated, because the
 * resolver owns validation. Neither read throws: a missing or unreadable file
 * is indistinguishable from "no memory key", and both resolve to disabled.
 */
function readMemoryLayers(workspaceRootPath?: string): {
  instance: unknown;
  workspace: unknown;
} {
  let instance: unknown;
  try {
    instance = getMemoryInstanceConfig();
  } catch {
    instance = undefined;
  }

  let workspace: unknown;
  if (workspaceRootPath) {
    try {
      workspace = loadWorkspaceConfig(workspaceRootPath)?.defaults?.memory;
    } catch {
      workspace = undefined;
    }
  }

  return { instance, workspace };
}

/**
 * Load and resolve the effective memory config for a workspace.
 *
 * A fresh install resolves to the disabled default. Malformed layers are
 * discarded by the resolver rather than thrown; this function does not throw.
 *
 * @param workspaceRootPath Absolute path to the workspace root. Omit to resolve
 *   the instance base alone (e.g. before a workspace is selected).
 */
export function loadEffectiveMemoryConfig(workspaceRootPath?: string): MemoryConfig {
  const { instance, workspace } = readMemoryLayers(workspaceRootPath);
  return resolveMemoryConfig(instance, workspace);
}

/**
 * Everything an editing surface needs about one workspace's memory config.
 *
 * `instanceEffective` answers "what would this workspace get if I cleared every
 * override?" — the value a cleared field reverts to, so a UI can show it
 * without knowing how the lower layers combine.
 */
export interface MemoryConfigView {
  /** Resolved config: workspace → instance → defaults. */
  effective: MemoryConfig;
  /** Resolved config with the workspace layer removed. */
  instanceEffective: MemoryConfig;
  /**
   * The workspace layer exactly as stored, or `undefined` when absent.
   *
   * Deliberately raw rather than sanitized: an editor reads this, changes one
   * field, and writes the whole object back, so sanitizing here would silently
   * drop keys written by a newer build. Never read it for precedence — use
   * `sources` and `effective`, which are validated.
   */
  overrides: MemoryConfigOverrides | undefined;
  /** Per-field provenance, matching `effective` field for field. */
  sources: MemoryConfigSources;
}

/**
 * Load the full editing view of a workspace's memory config.
 *
 * Pure read: resolution, validation, and provenance all come from the
 * `@craft-agent/core/types` resolver, so the settings UI holds no precedence
 * logic of its own. Does not throw.
 */
export function loadMemoryConfigView(workspaceRootPath?: string): MemoryConfigView {
  const { instance, workspace } = readMemoryLayers(workspaceRootPath);

  return {
    effective: resolveMemoryConfig(instance, workspace),
    instanceEffective: resolveMemoryConfig(instance, undefined),
    overrides: (workspace ?? undefined) as MemoryConfigOverrides | undefined,
    sources: resolveMemoryConfigSources(instance, workspace),
  };
}
