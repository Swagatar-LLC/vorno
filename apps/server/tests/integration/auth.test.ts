import { describe, test, expect, beforeAll } from 'bun:test';
import { createRouter } from '../../src/router';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';
import {
  generateApiKey,
  hashApiKey,
  loadServerConfig,
  saveServerConfig,
  type ServerConfig,
  type StoredApiKey,
} from '../../src/config';

/**
 * Create an in-memory server config with a test API key.
 * Does NOT write to disk — we mock at the router level.
 */
function createTestConfig(
  overrides?: Partial<StoredApiKey['permissions']>
): { config: ServerConfig; fullKey: string } {
  const { fullKey, stored } = generateApiKey('Test Key', {
    workspaceIds: [],
    permissionPolicy: 'allow-all',
    maxConcurrentSessions: 5,
    ...overrides,
  });

  const config: ServerConfig = {
    enabled: true,
    port: 3847,
    host: '127.0.0.1',
    apiKeys: [stored],
    rateLimits: {
      requestsPerMinute: 30,
      concurrentSessions: 5,
    },
  };

  return { config, fullKey };
}

function makeRequest(url: string, opts?: RequestInit & { apiKey?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts?.apiKey) {
    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  }
  if (opts?.headers) {
    Object.assign(headers, opts.headers);
  }
  return new Request(url, { ...opts, headers });
}

describe('Auth Integration', () => {
  let router: (request: Request) => Promise<Response>;
  let pool: SessionPool;

  beforeAll(() => {
    const eventBus = new EventBus();
    pool = new SessionPool(eventBus);
    router = createRouter(pool);
  });

  describe('Authentication', () => {
    test('missing Authorization header returns 401', async () => {
      const req = makeRequest('http://localhost:3847/api/workspaces');
      const res = await router(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Authorization');
    });

    test('non-Bearer format returns 401', async () => {
      const req = makeRequest('http://localhost:3847/api/workspaces', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      const res = await router(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('format');
    });

    test('wrong key prefix returns 401', async () => {
      const req = makeRequest('http://localhost:3847/api/workspaces', {
        apiKey: 'sk_wrong_prefix_12345',
      });
      const res = await router(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('format');
    });

    test('valid format but non-existent key returns 401', async () => {
      const req = makeRequest('http://localhost:3847/api/workspaces', {
        apiKey: 'craft_sk_thiskeyisvalidformatbutdoesnotexist',
      });
      const res = await router(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid API key');
    });

    test('empty Bearer token returns 401', async () => {
      const req = makeRequest('http://localhost:3847/api/workspaces', {
        headers: { Authorization: 'Bearer ' },
      });
      const res = await router(req);
      expect(res.status).toBe(401);
    });
  });

  describe('Authorization', () => {
    test('hasWorkspaceAccess — empty workspaceIds means all access', () => {
      const { hasWorkspaceAccess } = require('../../src/middleware/auth');
      const auth = {
        apiKey: {
          permissions: { workspaceIds: [] },
        },
      };
      expect(hasWorkspaceAccess(auth, 'any-workspace-id')).toBe(true);
    });

    test('hasWorkspaceAccess — specific IDs restrict access', () => {
      const { hasWorkspaceAccess } = require('../../src/middleware/auth');
      const auth = {
        apiKey: {
          permissions: { workspaceIds: ['ws-1', 'ws-2'] },
        },
      };
      expect(hasWorkspaceAccess(auth, 'ws-1')).toBe(true);
      expect(hasWorkspaceAccess(auth, 'ws-3')).toBe(false);
    });
  });

  describe('Permission policy capping', () => {
    test('getEffectivePolicy caps at key max', () => {
      const { getEffectivePolicy } = require('../../src/middleware/auth');

      // Key allows up to 'allow-safe', user requests 'allow-all'
      const auth = {
        apiKey: {
          permissions: { permissionPolicy: 'allow-safe' },
        },
      };

      expect(getEffectivePolicy(auth, 'allow-all')).toBe('allow-safe');
      expect(getEffectivePolicy(auth, 'deny-all')).toBe('deny-all');
      expect(getEffectivePolicy(auth, 'allow-safe')).toBe('allow-safe');
    });

    test('getEffectivePolicy defaults to deny-all with no request', () => {
      const { getEffectivePolicy } = require('../../src/middleware/auth');
      const auth = {
        apiKey: {
          permissions: { permissionPolicy: 'allow-all' },
        },
      };

      expect(getEffectivePolicy(auth)).toBe('deny-all');
    });
  });

  describe('Hash consistency', () => {
    test('generated key validates against its own hash', () => {
      const { fullKey, stored } = generateApiKey('Test', {
        workspaceIds: [],
        permissionPolicy: 'allow-safe',
        maxConcurrentSessions: 3,
      });

      const hash = hashApiKey(fullKey);
      expect(hash).toBe(stored.keyHash);
    });

    test('different keys produce different hashes', () => {
      const key1 = generateApiKey('Key 1', {
        workspaceIds: [],
        permissionPolicy: 'allow-safe',
        maxConcurrentSessions: 3,
      });
      const key2 = generateApiKey('Key 2', {
        workspaceIds: [],
        permissionPolicy: 'allow-safe',
        maxConcurrentSessions: 3,
      });

      expect(key1.stored.keyHash).not.toBe(key2.stored.keyHash);
    });
  });
});
