/**
 * Centralized path configuration for Craft Agent (VORNO fork).
 *
 * Resolution order (see config-dir-migration.ts for the full state machine):
 *   1. CRAFT_CONFIG_DIR env var — explicit override always wins. This is the
 *      documented escape hatch, used for multi-instance dev (detect-instance
 *      sets ~/.craft-agent-1, ~/.craft-agent-2, ...) and by scripts/daily-driver.ts,
 *      which deliberately shares upstream's ~/.craft-agent in thin-client mode.
 *   2. ~/.vorno-agent — the fork default. Requires no env var; on first use,
 *      existing fork data is migrated (copied, never moved) from
 *      ~/.craft-agent-swagatar or ~/.craft-agent. Upstream's dir is left
 *      byte-identical, so the fork and upstream stable can run side-by-side
 *      without fighting over .server.lock or each other's data (LEARNING-002).
 *
 * The migration runs synchronously at module-eval, before any consumer can
 * read or write CONFIG_DIR — there is no window for a partial-state launch.
 * Callers that want to log which dir is active (and why) should use
 * CONFIG_DIR_RESOLUTION.
 */

import { basename } from 'path';
import { ensureConfigDirReady, resolveConfigDir, type ConfigDirResolution } from './config-dir-migration.ts';

export type { ConfigDirResolution } from './config-dir-migration.ts';

/** Active config dir, how it was chosen, and the migration outcome (if any). */
export const CONFIG_DIR_RESOLUTION: ConfigDirResolution = ensureConfigDirReady();

export const CONFIG_DIR = CONFIG_DIR_RESOLUTION.dir;

/**
 * Directory name of the active config root (e.g. ".vorno-agent" or a
 * CRAFT_CONFIG_DIR override's basename). Used by permission/path heuristics
 * that need to recognize "inside the config dir" without hardcoding a name.
 */
export const CONFIG_DIR_NAME = basename(CONFIG_DIR);

/**
 * Dynamic (per-call) resolution of the config dir from the environment.
 * For code paths that intentionally re-read CRAFT_CONFIG_DIR at call time
 * (e.g. permissions-config, so tests can override it). Does NOT run the
 * migration — module-eval above already did.
 */
export function resolveConfigDirFromEnv(): string {
  return resolveConfigDir(process.env).dir;
}
