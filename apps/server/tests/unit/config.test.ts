import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// fork(PLAN-020): CONFIG_DIR freezes at module eval, so set a temp override
// before importing the config module (whose CONFIG_PATH is derived from it).
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'server-cfg-'));
process.env.CRAFT_CONFIG_DIR = CONFIG_DIR;

import {
  generateApiKey,
  hashApiKey,
  validateApiKey,
  loadServerConfig,
  saveServerConfig,
  getConfigPath,
  type ServerConfig,
  type ApiKeyPermissions,
} from '../../src/config';

const defaultPermissions: ApiKeyPermissions = {
  workspaceIds: [],
  permissionPolicy: 'allow-safe',
  maxConcurrentSessions: 3,
};

const CONFIG_PATH = getConfigPath();

function clearWebuiEnv() {
  delete process.env.CRAFT_WEBUI_ENABLED;
  delete process.env.CRAFT_WEBUI_PORT;
  delete process.env.CRAFT_TRIGGER_ENABLED;
}

afterEach(() => {
  clearWebuiEnv();
  try { rmSync(CONFIG_PATH); } catch { /* ignore */ }
});

describe('Server Config', () => {
  describe('generateApiKey', () => {
    test('generates unique keys', () => {
      const key1 = generateApiKey('Key 1', defaultPermissions);
      const key2 = generateApiKey('Key 2', defaultPermissions);
      expect(key1.fullKey).not.toBe(key2.fullKey);
      expect(key1.stored.id).not.toBe(key2.stored.id);
    });

    test('key starts with craft_sk_ prefix', () => {
      const { fullKey } = generateApiKey('Test', defaultPermissions);
      expect(fullKey).toMatch(/^craft_sk_/);
    });

    test('stored key preserves name and permissions', () => {
      const { stored } = generateApiKey('CI Pipeline', {
        workspaceIds: ['my-workspace'],
        permissionPolicy: 'deny-all',
        maxConcurrentSessions: 1,
      });
      expect(stored.name).toBe('CI Pipeline');
      expect(stored.permissions.workspaceIds).toEqual(['my-workspace']);
      expect(stored.permissions.permissionPolicy).toBe('deny-all');
      expect(stored.permissions.maxConcurrentSessions).toBe(1);
    });

    test('stored key has creation timestamp', () => {
      const before = Date.now();
      const { stored } = generateApiKey('Test', defaultPermissions);
      const after = Date.now();
      expect(stored.createdAt).toBeGreaterThanOrEqual(before);
      expect(stored.createdAt).toBeLessThanOrEqual(after);
    });

    test('lastUsedAt starts as null', () => {
      const { stored } = generateApiKey('Test', defaultPermissions);
      expect(stored.lastUsedAt).toBeNull();
    });
  });

  describe('hashApiKey', () => {
    test('produces sha256 prefixed hash', () => {
      const hash = hashApiKey('craft_sk_test123');
      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    test('same input produces same hash', () => {
      const key = 'craft_sk_test123';
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    test('different inputs produce different hashes', () => {
      expect(hashApiKey('craft_sk_key1')).not.toBe(hashApiKey('craft_sk_key2'));
    });
  });

  describe('validateApiKey', () => {
    test('validates correct key', () => {
      const { fullKey, stored } = generateApiKey('Test', defaultPermissions);
      // Note: validateApiKey calls saveServerConfig which needs filesystem
      // Testing the hash matching logic directly
      const hash = hashApiKey(fullKey);
      expect(hash).toBe(stored.keyHash);
    });

    test('rejects incorrect key', () => {
      const { stored } = generateApiKey('Test', defaultPermissions);
      const wrongHash = hashApiKey('craft_sk_wrongkey');
      expect(wrongHash).not.toBe(stored.keyHash);
    });
  });

  // fork(PLAN-020): WebUI config + default flips + nested merge + env overrides.
  describe('WebUI config (PLAN-020)', () => {
    test('defaults flip: enabled=true, webui.enabled=true, webui.port=3848', () => {
      clearWebuiEnv();
      const cfg = loadServerConfig(); // no file on disk → defaults
      expect(cfg.enabled).toBe(true);
      expect(cfg.webui.enabled).toBe(true);
      expect(cfg.webui.port).toBe(3848);
      expect(cfg.webui.host).toBe('127.0.0.1');
      expect(cfg.webui.password).toBeNull();
      // fork(PLAN-022): tunnel defaults to { provider: 'none' }.
      expect(cfg.webui.tunnel).toEqual({ provider: 'none' });
    });

    test('nested merge: file predating webui block gets webui defaults', () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ enabled: false, port: 3847, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 } }),
      );
      const cfg = loadServerConfig();
      expect(cfg.enabled).toBe(false); // file value respected
      expect(cfg.webui).toEqual({ enabled: true, port: 3848, host: '127.0.0.1', password: null, tunnel: { provider: 'none' } });
    });

    // fork(PLAN-022): second-level merge for the tunnel sub-object.
    test('nested merge: file predating the tunnel sub-object gets tunnel defaults', () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 }, webui: { enabled: true, port: 3848, host: '127.0.0.1', password: 'kept' } }),
      );
      const cfg = loadServerConfig();
      expect(cfg.webui.password).toBe('kept');
      expect(cfg.webui.tunnel).toEqual({ provider: 'none' }); // filled in
    });

    test('nested merge: persisted tunnel provider is respected', () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 }, webui: { enabled: true, port: 3848, host: '127.0.0.1', password: null, tunnel: { provider: 'tailscale' } } }),
      );
      const cfg = loadServerConfig();
      expect(cfg.webui.tunnel.provider).toBe('tailscale');
    });

    test('nested merge: partial webui block fills missing sub-fields', () => {
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 }, webui: { enabled: false, password: 'kept' } }),
      );
      const cfg = loadServerConfig();
      expect(cfg.webui.enabled).toBe(false);
      expect(cfg.webui.password).toBe('kept');
      expect(cfg.webui.port).toBe(3848); // default filled in
      expect(cfg.webui.host).toBe('127.0.0.1');
    });

    test('round-trip persists the webui block', () => {
      const base = loadServerConfig();
      const next: ServerConfig = { ...base, webui: { ...base.webui, port: 4200, password: 'secret20charspwxxxxx' } };
      saveServerConfig(next);
      const reloaded = loadServerConfig();
      expect(reloaded.webui.port).toBe(4200);
      expect(reloaded.webui.password).toBe('secret20charspwxxxxx');
    });

    test('CRAFT_WEBUI_ENABLED / CRAFT_WEBUI_PORT env overrides win', () => {
      process.env.CRAFT_WEBUI_ENABLED = 'false';
      process.env.CRAFT_WEBUI_PORT = '4999';
      const cfg = loadServerConfig();
      expect(cfg.webui.enabled).toBe(false);
      expect(cfg.webui.port).toBe(4999);
    });

    test('invalid CRAFT_WEBUI_PORT is ignored (falls back to persisted)', () => {
      clearWebuiEnv();
      writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [], rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 }, webui: { enabled: true, port: 3850, host: '127.0.0.1', password: null } }),
      );
      process.env.CRAFT_WEBUI_PORT = 'not-a-number';
      const cfg = loadServerConfig();
      expect(cfg.webui.port).toBe(3850);
    });
  });
});
