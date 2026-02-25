import { describe, test, expect, beforeEach } from 'bun:test';
import { authenticate, hasWorkspaceAccess, getEffectivePolicy, type AuthContext } from '../../src/middleware/auth';
import {
  generateApiKey,
  hashApiKey,
  type ServerConfig,
  type StoredApiKey,
  type ApiKeyPermissions,
} from '../../src/config';

function createMockConfig(keys: StoredApiKey[] = []): ServerConfig {
  return {
    enabled: true,
    port: 3847,
    host: '127.0.0.1',
    apiKeys: keys,
    rateLimits: {
      requestsPerMinute: 30,
      concurrentSessions: 5,
    },
  };
}

function createTestKey(overrides?: Partial<ApiKeyPermissions>): { fullKey: string; stored: StoredApiKey } {
  return generateApiKey('Test Key', {
    workspaceIds: [],
    permissionPolicy: 'allow-safe',
    maxConcurrentSessions: 3,
    ...overrides,
  });
}

describe('API Key Generation', () => {
  test('generates key with craft_sk_ prefix', () => {
    const { fullKey } = createTestKey();
    expect(fullKey.startsWith('craft_sk_')).toBe(true);
  });

  test('stored key has hash, not plaintext', () => {
    const { fullKey, stored } = createTestKey();
    expect(stored.keyHash.startsWith('sha256:')).toBe(true);
    expect(stored.keyHash).not.toContain(fullKey);
  });

  test('stored key has display prefix', () => {
    const { stored } = createTestKey();
    expect(stored.keyPrefix.startsWith('craft_sk_...')).toBe(true);
    expect(stored.keyPrefix.length).toBeLessThan(20);
  });

  test('hash matches generated key', () => {
    const { fullKey, stored } = createTestKey();
    const hash = hashApiKey(fullKey);
    expect(hash).toBe(stored.keyHash);
  });

  test('different keys produce different hashes', () => {
    const { stored: key1 } = createTestKey();
    const { stored: key2 } = createTestKey();
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });
});

describe('Authentication Middleware', () => {
  test('rejects missing Authorization header', () => {
    const request = new Request('http://localhost/api/sessions', { method: 'GET' });
    const config = createMockConfig();
    const result = authenticate(request, config);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test('rejects non-Bearer auth', () => {
    const request = new Request('http://localhost/api/sessions', {
      method: 'GET',
      headers: { Authorization: 'Basic abc123' },
    });
    const config = createMockConfig();
    const result = authenticate(request, config);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test('rejects invalid key format', () => {
    const request = new Request('http://localhost/api/sessions', {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid_key_123' },
    });
    const config = createMockConfig();
    const result = authenticate(request, config);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test('rejects unknown key', () => {
    const request = new Request('http://localhost/api/sessions', {
      method: 'GET',
      headers: { Authorization: 'Bearer craft_sk_unknownkey123456' },
    });
    const config = createMockConfig();
    const result = authenticate(request, config);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(401);
    }
  });

  test('accepts valid key', () => {
    const { fullKey, stored } = createTestKey();
    const config = createMockConfig([stored]);
    const request = new Request('http://localhost/api/sessions', {
      method: 'GET',
      headers: { Authorization: `Bearer ${fullKey}` },
    });
    const result = authenticate(request, config);
    expect('auth' in result).toBe(true);
    if ('auth' in result) {
      expect(result.auth.apiKey.id).toBe(stored.id);
    }
  });
});

describe('Workspace Access', () => {
  test('empty workspaceIds grants access to all', () => {
    const { stored } = createTestKey({ workspaceIds: [] });
    const auth: AuthContext = { apiKey: stored };
    expect(hasWorkspaceAccess(auth, 'any-workspace')).toBe(true);
  });

  test('scoped workspaceIds restricts access', () => {
    const { stored } = createTestKey({ workspaceIds: ['my-workspace'] });
    const auth: AuthContext = { apiKey: stored };
    expect(hasWorkspaceAccess(auth, 'my-workspace')).toBe(true);
    expect(hasWorkspaceAccess(auth, 'other-workspace')).toBe(false);
  });
});

describe('Effective Policy', () => {
  test('caps requested policy at key maximum', () => {
    const { stored } = createTestKey({ permissionPolicy: 'allow-safe' });
    const auth: AuthContext = { apiKey: stored };
    expect(getEffectivePolicy(auth, 'allow-all')).toBe('allow-safe');
    expect(getEffectivePolicy(auth, 'allow-safe')).toBe('allow-safe');
    expect(getEffectivePolicy(auth, 'deny-all')).toBe('deny-all');
  });

  test('allow-all key permits all policies', () => {
    const { stored } = createTestKey({ permissionPolicy: 'allow-all' });
    const auth: AuthContext = { apiKey: stored };
    expect(getEffectivePolicy(auth, 'allow-all')).toBe('allow-all');
    expect(getEffectivePolicy(auth, 'allow-safe')).toBe('allow-safe');
    expect(getEffectivePolicy(auth, 'deny-all')).toBe('deny-all');
  });

  test('deny-all key restricts to deny-all only', () => {
    const { stored } = createTestKey({ permissionPolicy: 'deny-all' });
    const auth: AuthContext = { apiKey: stored };
    expect(getEffectivePolicy(auth, 'allow-all')).toBe('deny-all');
    expect(getEffectivePolicy(auth, 'allow-safe')).toBe('deny-all');
    expect(getEffectivePolicy(auth, 'deny-all')).toBe('deny-all');
  });

  test('defaults to deny-all when no policy requested', () => {
    const { stored } = createTestKey({ permissionPolicy: 'allow-all' });
    const auth: AuthContext = { apiKey: stored };
    expect(getEffectivePolicy(auth)).toBe('deny-all');
  });
});
