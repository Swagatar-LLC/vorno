/**
 * Context-profile storage — fork(PLAN-030 Phase 3).
 *
 * `{workspaceRootPath}/context-profiles/config.json`. Read straight off disk on every
 * call, exactly like `isValidStatusId` / `loadStatusConfig` — there is no cache, so there
 * is nothing for the ConfigWatcher to invalidate and no watcher entry to keep in sync.
 * An edit to the file takes effect on the next automation fire.
 *
 * A missing file is empty, not an error: profiles are inherently workspace-specific
 * (they name absolute paths and local source slugs), so there is no useful built-in set
 * to seed, and seeding one would only invent a default someone has to delete.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readJsonFileSync } from '../utils/files.ts';
import { WorkspaceContextProfilesConfigSchema } from './schema.ts';
import type { ContextProfile, WorkspaceContextProfilesConfig } from './types.ts';

const CONTEXT_PROFILES_DIR = 'context-profiles';
const CONTEXT_PROFILES_CONFIG_FILE = 'context-profiles/config.json';

/** Path to a workspace's context-profile config, whether or not it exists. */
export function getContextProfilesConfigPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, CONTEXT_PROFILES_CONFIG_FILE);
}

function emptyConfig(): WorkspaceContextProfilesConfig {
  return { version: 1, profiles: [] };
}

/**
 * Load and validate the workspace's context profiles.
 *
 * An invalid file yields **no profiles**, loudly. Partial acceptance was the alternative
 * and it is worse here than the lenient action-schema path it superficially resembles: a
 * profile carries a permission mode, so half-parsing one risks applying a context nobody
 * reviewed as a whole. `apply-context` then reports `rejected:unknown-profile`, which is
 * a visible refusal in run history rather than a silent partial application.
 */
export function loadContextProfilesConfig(workspaceRootPath: string): WorkspaceContextProfilesConfig {
  const configPath = getContextProfilesConfigPath(workspaceRootPath);
  if (!existsSync(configPath)) return emptyConfig();

  let raw: unknown;
  try {
    raw = readJsonFileSync<unknown>(configPath);
  } catch (error) {
    console.error('[loadContextProfilesConfig] Failed to parse config:', error);
    return emptyConfig();
  }

  const parsed = WorkspaceContextProfilesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      console.warn(`[loadContextProfilesConfig] ${CONTEXT_PROFILES_CONFIG_FILE} → ${where}: ${issue.message}`);
    }
    return emptyConfig();
  }

  return parsed.data as WorkspaceContextProfilesConfig;
}

/** A single profile by id, or `null` if the workspace does not define it. */
export function getContextProfile(workspaceRootPath: string, profileId: string): ContextProfile | null {
  return loadContextProfilesConfig(workspaceRootPath).profiles.find((p) => p.id === profileId) ?? null;
}

/** Write the config back. Used by tests and by any future management surface. */
export function saveContextProfilesConfig(
  workspaceRootPath: string,
  config: WorkspaceContextProfilesConfig,
): void {
  const dir = join(workspaceRootPath, CONTEXT_PROFILES_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getContextProfilesConfigPath(workspaceRootPath), JSON.stringify(config, null, 2), 'utf-8');
}
