import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes, createHash } from 'crypto';
import { CONFIG_DIR } from '@craft-agent/shared/config/paths';

/**
 * API key permissions scoped to specific workspaces and permission levels.
 */
export interface ApiKeyPermissions {
  /** Workspace IDs this key can access (empty = all) */
  workspaceIds: string[];
  /** Maximum permission policy this key can use */
  permissionPolicy: 'deny-all' | 'allow-safe' | 'allow-all';
  /** Max concurrent sessions for this key */
  maxConcurrentSessions: number;
}

/**
 * Stored API key (hash-only, never stores plaintext).
 */
export interface StoredApiKey {
  id: string;
  name: string;
  /** SHA-256 hash of the full key */
  keyHash: string;
  /** Key prefix for display (e.g., "craft_sk_...a3f") */
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  permissions: ApiKeyPermissions;
}

/**
 * Rate limit configuration.
 */
export interface RateLimits {
  requestsPerMinute: number;
  concurrentSessions: number;
}

/**
 * fork(PLAN-020): WebUI listener configuration (browser-served SPA + JWT login).
 *
 * Persisted alongside the trigger-server config in server-config.json. `enabled`
 * is DESIRED state (start/stop persist it, mirroring the trigger server). The
 * password is generated + persisted on first WebUI start and is intentionally
 * displayable in settings/tray (LOCAL_ONLY IPC), so it is stored plaintext.
 */
/**
 * fork(PLAN-022): secure-tunnel provider selection for the WebUI listener.
 *
 * An extensible shape — `provider` is a small closed union so future providers
 * (cloudflared etc.) slot in without a config migration. Only `'tailscale'` is
 * implemented in leg 4; `'none'` (the default) disables tunnelling. When set to
 * `'tailscale'`, the main process manages a `tailscale serve` rule fronting the
 * WebUI port on start and clears it on stop.
 */
export interface WebUiTunnelConfig {
  /** default 'none' — 'tailscale' fronts the WebUI port with `tailscale serve`. */
  provider: 'none' | 'tailscale';
}

export interface WebUiConfig {
  /** default true — desired state, persisted by start/stop */
  enabled: boolean;
  /** default 3848 */
  port: number;
  /** default '127.0.0.1' — surfaced in Remote Access settings (PLAN-022 leg 3) as a
   *  127.0.0.1 / 0.0.0.0 dropdown; a hand-edited interface IP is preserved and shown
   *  as a "custom" option. */
  host: string;
  /** default null — generated + persisted on first start */
  password: string | null;
  /** fork(PLAN-022): secure-tunnel provider selection (default { provider: 'none' }). */
  tunnel: WebUiTunnelConfig;
}

/**
 * Server configuration stored at {CONFIG_DIR}/server-config.json
 */
export interface ServerConfig {
  enabled: boolean;
  port: number;
  host: string;
  apiKeys: StoredApiKey[];
  rateLimits: RateLimits;
  /** fork(PLAN-020): WebUI listener config block. */
  webui: WebUiConfig;
}

// fork(PLAN-022): default tunnel config — no tunnel until the user opts in.
const DEFAULT_WEBUI_TUNNEL_CONFIG: WebUiTunnelConfig = {
  provider: 'none',
};

// fork(PLAN-020): default WebUI config — zero-config autostart on loopback.
const DEFAULT_WEBUI_CONFIG: WebUiConfig = {
  enabled: true,
  port: 3848,
  host: '127.0.0.1',
  password: null,
  tunnel: { ...DEFAULT_WEBUI_TUNNEL_CONFIG },
};

const DEFAULT_CONFIG: ServerConfig = {
  // fork(PLAN-020): flipped false → true so the trigger server autostarts
  // zero-config on a fresh install (safe: no API keys ⇒ every request denied,
  // loopback bind, /hooks 404s with no hooks configured).
  enabled: true,
  port: 3847,
  host: '127.0.0.1',
  apiKeys: [],
  rateLimits: {
    requestsPerMinute: 30,
    concurrentSessions: 5,
  },
  webui: { ...DEFAULT_WEBUI_CONFIG },
};

const CONFIG_PATH = join(CONFIG_DIR, 'server-config.json');

/**
 * Apply optional, non-secret bind-address overrides from the environment.
 *
 * `CRAFT_TRIGGER_HOST` / `CRAFT_TRIGGER_PORT` take precedence over the persisted
 * host/port in server-config.json (PLAN-013 work item 4). These are deliberately
 * env-driven: bind address is not a secret, and in a container the config file
 * lives in a mounted volume that may be provisioned separately from the runtime
 * environment. Invalid values are ignored (with a warning) rather than fatal, so
 * a typo can never silently change the bind address to something unexpected.
 * Returns the same object (mutated) for convenience.
 */
export function applyEnvOverrides(config: ServerConfig): ServerConfig {
  // Enable/disable the server without editing the persisted file — lets a
  // container run against a fresh volume (no server-config.json yet) or lets an
  // operator flip a deployment on/off from the environment. Non-secret.
  const enabledRaw = process.env.CRAFT_TRIGGER_ENABLED?.trim().toLowerCase();
  if (enabledRaw !== undefined && enabledRaw !== '') {
    if (['1', 'true', 'yes', 'on'].includes(enabledRaw)) {
      config.enabled = true;
    } else if (['0', 'false', 'no', 'off'].includes(enabledRaw)) {
      config.enabled = false;
    } else {
      console.warn(
        `[config] Ignoring unrecognized CRAFT_TRIGGER_ENABLED=${enabledRaw} ` +
        `(use 1/0, true/false, yes/no, on/off); using ${config.enabled}.`
      );
    }
  }

  const host = process.env.CRAFT_TRIGGER_HOST?.trim();
  if (host) {
    config.host = host;
  }

  const portRaw = process.env.CRAFT_TRIGGER_PORT?.trim();
  if (portRaw) {
    const port = Number.parseInt(portRaw, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      config.port = port;
    } else {
      console.warn(
        `[config] Ignoring invalid CRAFT_TRIGGER_PORT=${portRaw} (must be an integer 1-65535); ` +
        `using ${config.port}.`
      );
    }
  }

  // fork(PLAN-020): WebUI env overrides mirror the CRAFT_TRIGGER_* pattern for
  // containers/CI. Non-secret (enable flag + bind port); the password is never
  // env-driven.
  const webuiEnabledRaw = process.env.CRAFT_WEBUI_ENABLED?.trim().toLowerCase();
  if (webuiEnabledRaw !== undefined && webuiEnabledRaw !== '') {
    if (['1', 'true', 'yes', 'on'].includes(webuiEnabledRaw)) {
      config.webui.enabled = true;
    } else if (['0', 'false', 'no', 'off'].includes(webuiEnabledRaw)) {
      config.webui.enabled = false;
    } else {
      console.warn(
        `[config] Ignoring unrecognized CRAFT_WEBUI_ENABLED=${webuiEnabledRaw} ` +
        `(use 1/0, true/false, yes/no, on/off); using ${config.webui.enabled}.`
      );
    }
  }

  const webuiPortRaw = process.env.CRAFT_WEBUI_PORT?.trim();
  if (webuiPortRaw) {
    const port = Number.parseInt(webuiPortRaw, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      config.webui.port = port;
    } else {
      console.warn(
        `[config] Ignoring invalid CRAFT_WEBUI_PORT=${webuiPortRaw} (must be an integer 1-65535); ` +
        `using ${config.webui.port}.`
      );
    }
  }

  return config;
}

/**
 * Load server configuration from disk.
 * Returns default config if file doesn't exist.
 * Env overrides (CRAFT_TRIGGER_HOST/PORT) are applied last and always win.
 */
export function loadServerConfig(): ServerConfig {
  let config: ServerConfig = { ...DEFAULT_CONFIG };
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULT_CONFIG, ...parsed };
      // fork(PLAN-020): nested merge so files predating the `webui` block pick up
      // new sub-fields (and defaults) instead of inheriting `undefined`.
      config.webui = { ...DEFAULT_WEBUI_CONFIG, ...(parsed.webui ?? {}) };
      // fork(PLAN-022): second-level merge so files predating the `tunnel`
      // sub-object (spread above would inherit `undefined` from parsed.webui)
      // pick up `{ provider: 'none' }` and any future tunnel sub-fields.
      config.webui.tunnel = {
        ...DEFAULT_WEBUI_TUNNEL_CONFIG,
        ...(parsed.webui?.tunnel ?? {}),
      };
    }
  } catch {
    // Fall through to defaults
  }
  return applyEnvOverrides(config);
}

/**
 * Save server configuration to disk.
 */
export function saveServerConfig(config: ServerConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Generate a new API key with the craft_sk_ prefix.
 * Returns both the full key (show once) and the stored key (hash-only).
 */
export function generateApiKey(
  name: string,
  permissions: ApiKeyPermissions
): { fullKey: string; stored: StoredApiKey } {
  const keyBytes = randomBytes(32);
  const keyBase62 = keyBytes.toString('base64url').replace(/[_-]/g, '');
  const fullKey = `craft_sk_${keyBase62}`;

  const keyHash = hashApiKey(fullKey);
  const keyPrefix = `craft_sk_...${keyBase62.slice(-3)}`;

  const stored: StoredApiKey = {
    id: `key_${randomBytes(8).toString('hex')}`,
    name,
    keyHash,
    keyPrefix,
    createdAt: Date.now(),
    lastUsedAt: null,
    permissions,
  };

  return { fullKey, stored };
}

/**
 * Hash an API key using SHA-256.
 */
export function hashApiKey(key: string): string {
  return `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Validate an API key against stored keys.
 * Returns the matching stored key or null.
 */
export function validateApiKey(key: string, config: ServerConfig): StoredApiKey | null {
  const hash = hashApiKey(key);
  const match = config.apiKeys.find(k => k.keyHash === hash);

  if (match) {
    // Update lastUsedAt
    match.lastUsedAt = Date.now();
    saveServerConfig(config);
  }

  return match ?? null;
}

/**
 * Add an API key to the config.
 */
export function addApiKey(config: ServerConfig, stored: StoredApiKey): void {
  config.apiKeys.push(stored);
  saveServerConfig(config);
}

/**
 * Revoke an API key by ID.
 */
export function revokeApiKey(config: ServerConfig, keyId: string): boolean {
  const index = config.apiKeys.findIndex(k => k.id === keyId);
  if (index === -1) return false;
  config.apiKeys.splice(index, 1);
  saveServerConfig(config);
  return true;
}

/**
 * Get the config file path (for display/debugging).
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}
