import { describe, test, expect } from 'bun:test';
import {
  generateApiKey,
  hashApiKey,
  validateApiKey,
  type ServerConfig,
  type ApiKeyPermissions,
} from '../../src/config';

const defaultPermissions: ApiKeyPermissions = {
  workspaceIds: [],
  permissionPolicy: 'allow-safe',
  maxConcurrentSessions: 3,
};

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
});
