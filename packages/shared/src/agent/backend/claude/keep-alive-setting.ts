/**
 * fork(PLAN-011): Settings-driven resolution of the background-agent keep-alive
 * flag.
 *
 * Upstream ships an env-only opt-out (`CRAFT_KEEP_BG_AGENTS_ALIVE`) resolved by
 * `resolveKeepBackgroundTasksAlive` in `persistent-input.ts`. That file is left
 * byte-identical so the fork stays wire- and test-compatible; this module layers
 * a durable app-level setting *underneath* the env var.
 *
 * Resolution order (see PLAN-011 §2 "Precedence"):
 *   - env set (`'1'/'true'/'0'/'false'`)  → env wins (`envOverride: true`)
 *   - env unset                            → stored app setting
 *   - nothing                              → true (upstream default)
 *
 * The env var wins on purpose: it preserves upstream's documented kill-switch
 * contract for scripts/CI/support. When the env forces the value, the Settings
 * toggle renders disabled with a hint (the `envOverride` flag drives that UI).
 *
 * Both consumers (`ClaudeAgent`, `SessionManager`) run in the Electron main
 * process, so reading `storage.ts` directly covers both — no override registry,
 * no IPC to the agent. The headless `apps/server` inherits the same config file.
 */
import { getKeepBackgroundAgentsAlive } from '../../../config/storage.ts';

export interface KeepAliveState {
  enabled: boolean;
  envOverride: boolean;
}

/**
 * Resolve the keep-alive state, returning both the effective value and whether
 * the env var forced it. `readStored` is injectable so unit tests need no fs.
 */
export function getKeepBackgroundTasksAliveState(
  env: Record<string, string | undefined> = process.env,
  readStored: () => boolean = getKeepBackgroundAgentsAlive,
): KeepAliveState {
  const raw = env.CRAFT_KEEP_BG_AGENTS_ALIVE;
  if (raw === '1' || raw === 'true') return { enabled: true, envOverride: true };
  if (raw === '0' || raw === 'false') return { enabled: false, envOverride: true };
  return { enabled: readStored(), envOverride: false };
}

/** Convenience: the effective keep-alive boolean (env-or-stored-or-default). */
export function isKeepBackgroundTasksAliveEnabled(): boolean {
  return getKeepBackgroundTasksAliveState().enabled;
}
