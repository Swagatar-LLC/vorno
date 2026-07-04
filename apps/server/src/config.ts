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
 * Server configuration stored at {CONFIG_DIR}/server-config.json
 */
export interface ServerConfig {
  enabled: boolean;
  port: number;
  host: string;
  apiKeys: StoredApiKey[];
  rateLimits: RateLimits;
}

const DEFAULT_CONFIG: ServerConfig = {
  enabled: false,
  port: 3847,
  host: '127.0.0.1',
  apiKeys: [],
  rateLimits: {
    requestsPerMinute: 30,
    concurrentSessions: 5,
  },
};

const CONFIG_PATH = join(CONFIG_DIR, 'server-config.json');

/**
 * Load server configuration from disk.
 * Returns default config if file doesn't exist.
 */
export function loadServerConfig(): ServerConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
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
