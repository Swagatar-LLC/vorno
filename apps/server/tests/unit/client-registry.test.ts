import { describe, test, expect } from 'bun:test';
import { ClientRegistry } from '../../src/transport/client-registry';
import type { TransportClient } from '../../src/transport/types';
import type { StoredApiKey } from '../../src/config';

function makeApiKey(id = 'key_test'): StoredApiKey {
  return {
    id,
    name: 'test-key',
    keyHash: 'sha256:abc',
    keyPrefix: 'craft_sk_...abc',
    createdAt: Date.now(),
    lastUsedAt: null,
    permissions: {
      workspaceIds: [],
      permissionPolicy: 'allow-all',
      maxConcurrentSessions: 5,
    },
  };
}

function makeClient(overrides: Partial<TransportClient> = {}): TransportClient {
  return {
    clientId: overrides.clientId ?? 'client-1',
    kind: overrides.kind ?? 'websocket',
    apiKey: overrides.apiKey ?? makeApiKey(),
    workspaceId: overrides.workspaceId ?? 'ws-1',
    capabilities: overrides.capabilities ?? new Set(),
    connectedAt: overrides.connectedAt ?? Date.now(),
    subscribedSessions: overrides.subscribedSessions ?? new Set(),
  };
}

describe('ClientRegistry', () => {
  test('register and get client', () => {
    const registry = new ClientRegistry();
    const client = makeClient();

    registry.register(client, () => {});

    expect(registry.get('client-1')).toBe(client);
    expect(registry.size).toBe(1);
  });

  test('unregister removes client', () => {
    const registry = new ClientRegistry();
    const client = makeClient();

    registry.register(client, () => {});
    registry.unregister('client-1');

    expect(registry.get('client-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test('unregister non-existent client is no-op', () => {
    const registry = new ClientRegistry();
    registry.unregister('nonexistent');
    expect(registry.size).toBe(0);
  });

  test('push to all clients', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    registry.register(makeClient({ clientId: 'c1' }), (ch) => received.push(`c1:${ch}`));
    registry.register(makeClient({ clientId: 'c2' }), (ch) => received.push(`c2:${ch}`));

    registry.push('test:event', { to: 'all' });

    expect(received).toEqual(['c1:test:event', 'c2:test:event']);
  });

  test('push to all with exclude', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    registry.register(makeClient({ clientId: 'c1' }), (ch) => received.push(`c1:${ch}`));
    registry.register(makeClient({ clientId: 'c2' }), (ch) => received.push(`c2:${ch}`));

    registry.push('test:event', { to: 'all', exclude: 'c1' });

    expect(received).toEqual(['c2:test:event']);
  });

  test('push to workspace', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    registry.register(makeClient({ clientId: 'c1', workspaceId: 'ws-1' }), (ch) => received.push(`c1:${ch}`));
    registry.register(makeClient({ clientId: 'c2', workspaceId: 'ws-2' }), (ch) => received.push(`c2:${ch}`));
    registry.register(makeClient({ clientId: 'c3', workspaceId: 'ws-1' }), (ch) => received.push(`c3:${ch}`));

    registry.push('test:event', { to: 'workspace', workspaceId: 'ws-1' });

    expect(received).toEqual(['c1:test:event', 'c3:test:event']);
  });

  test('push to specific client', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    registry.register(makeClient({ clientId: 'c1' }), (ch) => received.push(`c1:${ch}`));
    registry.register(makeClient({ clientId: 'c2' }), (ch) => received.push(`c2:${ch}`));

    registry.push('test:event', { to: 'client', clientId: 'c2' });

    expect(received).toEqual(['c2:test:event']);
  });

  test('pushToSession sends to subscribed clients only', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    const sub = new Set(['session-1']);
    const nosub = new Set<string>();

    registry.register(makeClient({ clientId: 'c1', subscribedSessions: sub }), (ch) => received.push(`c1:${ch}`));
    registry.register(makeClient({ clientId: 'c2', subscribedSessions: nosub }), (ch) => received.push(`c2:${ch}`));
    registry.register(makeClient({ clientId: 'c3', subscribedSessions: sub }), (ch) => received.push(`c3:${ch}`));

    registry.pushToSession('session-1', 'sessions:event');

    expect(received).toEqual(['c1:sessions:event', 'c3:sessions:event']);
  });

  test('bad push callback does not break other clients', () => {
    const registry = new ClientRegistry();
    const received: string[] = [];

    registry.register(makeClient({ clientId: 'c1' }), () => { throw new Error('bad'); });
    registry.register(makeClient({ clientId: 'c2' }), (ch) => received.push(`c2:${ch}`));

    registry.push('test:event', { to: 'all' });

    expect(received).toEqual(['c2:test:event']);
  });

  test('countByKind', () => {
    const registry = new ClientRegistry();

    registry.register(makeClient({ clientId: 'c1', kind: 'websocket' }), () => {});
    registry.register(makeClient({ clientId: 'c2', kind: 'sse' }), () => {});
    registry.register(makeClient({ clientId: 'c3', kind: 'websocket' }), () => {});

    expect(registry.countByKind('websocket')).toBe(2);
    expect(registry.countByKind('sse')).toBe(1);
  });

  test('getByKind', () => {
    const registry = new ClientRegistry();

    const wsClient = makeClient({ clientId: 'c1', kind: 'websocket' });
    const sseClient = makeClient({ clientId: 'c2', kind: 'sse' });

    registry.register(wsClient, () => {});
    registry.register(sseClient, () => {});

    expect(registry.getByKind('websocket')).toEqual([wsClient]);
    expect(registry.getByKind('sse')).toEqual([sseClient]);
  });

  test('getBySession', () => {
    const registry = new ClientRegistry();

    const c1 = makeClient({ clientId: 'c1', subscribedSessions: new Set(['s1', 's2']) });
    const c2 = makeClient({ clientId: 'c2', subscribedSessions: new Set(['s2']) });
    const c3 = makeClient({ clientId: 'c3', subscribedSessions: new Set(['s3']) });

    registry.register(c1, () => {});
    registry.register(c2, () => {});
    registry.register(c3, () => {});

    expect(registry.getBySession('s2')).toEqual([c1, c2]);
    expect(registry.getBySession('s3')).toEqual([c3]);
    expect(registry.getBySession('nonexistent')).toEqual([]);
  });
});
