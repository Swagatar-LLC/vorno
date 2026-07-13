/**
 * fork(PLAN-018 / ADR-0009): runtime-configurable auto-update feed.
 *
 * Owns `updater-config.json` in CONFIG_DIR (the fork default is ~/.vorno-agent).
 * The packaged build ships `app-update.yml` pointing at a feed, but that feed is
 * baked at build time. This module lets the running app override it at runtime
 * WITHOUT a rebuild — the main process reads this config and calls
 * `autoUpdater.setFeedURL(...)` before any update check.
 *
 * Default feed: the fork-owned public GitHub repo `Swagatar-LLC/vorno-releases`
 * (electron-updater `github` provider). It does not exist yet — an absent/404
 * feed degrades to a logged no-update, never a hard failure (see auto-update.ts).
 *
 * Load/save pattern mirrors preferences.ts. A malformed file on disk is logged
 * and replaced (in memory) by defaults — this module NEVER throws at startup.
 */

import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureConfigDir } from './storage.ts';
import { CONFIG_DIR } from './paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';

export type UpdaterProvider = 'github' | 'generic';

/**
 * Fully-resolved updater feed configuration. `loadUpdaterConfig()` always returns
 * a config with `channel` and `autoCheck` populated (defaults applied), and with
 * the provider-specific fields present for the active provider.
 */
export interface UpdaterConfig {
  provider: UpdaterProvider;
  /** GitHub repo owner (provider === 'github'). Non-empty. */
  owner?: string;
  /** GitHub repo name (provider === 'github'). Non-empty. */
  repo?: string;
  /** Generic feed URL (provider === 'generic'). Must be https. */
  url?: string;
  /** Release channel (e.g. 'latest', 'beta'). Default 'latest'. */
  channel: string;
  /** Whether to check for updates automatically on launch. Default true. */
  autoCheck: boolean;
}

/** Fork default feed — the public releases repo (ADR-0009). */
export const DEFAULT_UPDATER_CONFIG: UpdaterConfig = {
  provider: 'github',
  owner: 'Swagatar-LLC',
  repo: 'vorno-releases',
  channel: 'latest',
  autoCheck: true,
};

const UPDATER_CONFIG_FILE = join(CONFIG_DIR, 'updater-config.json');

export function getUpdaterConfigPath(): string {
  return UPDATER_CONFIG_FILE;
}

/**
 * Validate and normalize an arbitrary value into a fully-resolved UpdaterConfig.
 *
 * Used by BOTH the RPC setFeedConfig handler (which rejects bad input) and the
 * load path (which falls back to defaults). Missing `channel`/`autoCheck` are
 * filled from the defaults; absent provider defaults to 'github'.
 *
 * Returns a discriminated result rather than throwing so callers choose the
 * failure policy (reject vs. warn-and-default).
 */
export function validateUpdaterConfig(
  input: unknown,
): { ok: true; config: UpdaterConfig } | { ok: false; error: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: 'Config must be an object' };
  }
  const raw = input as Record<string, unknown>;

  // Provider — default to 'github' when omitted (matches the default config).
  const provider = raw.provider === undefined ? 'github' : raw.provider;
  if (provider !== 'github' && provider !== 'generic') {
    return { ok: false, error: `Invalid provider: ${String(provider)} (expected 'github' | 'generic')` };
  }

  // Channel — optional; must be a non-empty string when present.
  let channel = DEFAULT_UPDATER_CONFIG.channel;
  if (raw.channel !== undefined) {
    if (typeof raw.channel !== 'string' || raw.channel.trim() === '') {
      return { ok: false, error: 'channel must be a non-empty string' };
    }
    channel = raw.channel.trim();
  }

  // autoCheck — optional boolean.
  let autoCheck = DEFAULT_UPDATER_CONFIG.autoCheck;
  if (raw.autoCheck !== undefined) {
    if (typeof raw.autoCheck !== 'boolean') {
      return { ok: false, error: 'autoCheck must be a boolean' };
    }
    autoCheck = raw.autoCheck;
  }

  if (provider === 'github') {
    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
    if (!owner) return { ok: false, error: 'owner is required for the github provider' };
    if (!repo) return { ok: false, error: 'repo is required for the github provider' };
    return { ok: true, config: { provider: 'github', owner, repo, channel, autoCheck } };
  }

  // generic
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return { ok: false, error: 'url is required for the generic provider' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'url must be a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must use https' };
  }
  return { ok: true, config: { provider: 'generic', url, channel, autoCheck } };
}

/**
 * Load the updater config from disk, applying defaults for absent/missing fields.
 * A missing file returns the defaults. A malformed or invalid file is logged and
 * the defaults are returned — this never throws at startup.
 */
export function loadUpdaterConfig(): UpdaterConfig {
  try {
    if (!existsSync(UPDATER_CONFIG_FILE)) {
      return { ...DEFAULT_UPDATER_CONFIG };
    }
    const raw = readJsonFileSync<unknown>(UPDATER_CONFIG_FILE);
    const result = validateUpdaterConfig(raw);
    if (!result.ok) {
      debug(`[updater] Ignoring malformed updater-config.json (${result.error}); using defaults`);
      return { ...DEFAULT_UPDATER_CONFIG };
    }
    return result.config;
  } catch (error) {
    debug('[updater] Failed to read updater-config.json; using defaults:', error instanceof Error ? error.message : error);
    return { ...DEFAULT_UPDATER_CONFIG };
  }
}

/**
 * Persist an updater config. Validates first and throws on invalid input so the
 * RPC handler surfaces a clear rejection. Writes the normalized (resolved) shape.
 */
export function saveUpdaterConfig(config: unknown): UpdaterConfig {
  const result = validateUpdaterConfig(config);
  if (!result.ok) {
    throw new Error(`Invalid updater config: ${result.error}`);
  }
  ensureConfigDir();
  writeFileSync(UPDATER_CONFIG_FILE, JSON.stringify(result.config, null, 2), 'utf-8');
  return result.config;
}
