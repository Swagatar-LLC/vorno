import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol';
import { serializeEnvelope, deserializeEnvelope } from '@craft-agent/server-core/transport';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';
import { ClientRegistry } from '../../src/transport/client-registry';
import { WsTransport } from '../../src/transport/ws-transport';
import { createRouter } from '../../src/router';
import { generateApiKey, type ServerConfig } from '../../src/config';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a test API key and in-memory config */
function createTestConfig(): { config: ServerConfig; fullKey: string } {
  const { fullKey, stored } = generateApiKey('test', {
    workspaceIds: [],
    permissionPolicy: 'allow-all',
    maxConcurrentSessions: 5,
  });

  const config: ServerConfig = {
    enabled: true,
    port: 0, // random
    host: '127.0.0.1',
    apiKeys: [stored],
    rateLimits: { requestsPerMinute: 100, concurrentSessions: 10 },
  };

  return { config, fullKey };
}

/** Send a WebSocket handshake and wait for the ack */
async function wsHandshake(
  ws: WebSocket,
  token: string,
  workspaceId?: string,
): Promise<MessageEnvelope> {
  const handshake: MessageEnvelope = {
    id: crypto.randomUUID(),
    type: 'handshake',
    protocolVersion: PROTOCOL_VERSION,
    token,
    workspaceId,
    clientCapabilities: ['sessions:event'],
  };

  ws.send(serializeEnvelope(handshake));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5000);
    ws.onmessage = (event) => {
      clearTimeout(timeout);
      const envelope = deserializeEnvelope(event.data as string);
      resolve(envelope);
    };
  });
}

/** Send an RPC request and wait for the response */
async function wsRequest(
  ws: WebSocket,
  channel: string,
  args: unknown[],
): Promise<MessageEnvelope> {
  const request: MessageEnvelope = {
    id: crypto.randomUUID(),
    type: 'request',
    channel,
    args,
  };

  ws.send(serializeEnvelope(request));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Request timeout: ${channel}`)), 5000);
    ws.onmessage = (event) => {
      clearTimeout(timeout);
      const envelope = deserializeEnvelope(event.data as string);
      if (envelope.type === 'response' && envelope.id === request.id) {
        resolve(envelope);
      }
    };
  });
}

/** Collect WebSocket events for a duration */
function collectWsEvents(ws: WebSocket, durationMs: number): Promise<MessageEnvelope[]> {
  const events: MessageEnvelope[] = [];
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const envelope = deserializeEnvelope(event.data as string);
      if (envelope.type === 'event') {
        events.push(envelope);
      }
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      resolve(events);
    }, durationMs);
  });
}

// ---------------------------------------------------------------------------
// Dual-transport integration tests
// ---------------------------------------------------------------------------

describe('Dual-Transport Server', () => {
  let server: ReturnType<typeof Bun.serve>;
  let pool: SessionPool;
  let eventBus: EventBus;
  let registry: ClientRegistry;
  let wsTransport: WsTransport;
  let port: number;
  let apiKey: string;

  beforeAll(() => {
    const { config, fullKey } = createTestConfig();
    apiKey = fullKey;

    eventBus = new EventBus();
    pool = new SessionPool(eventBus);
    registry = new ClientRegistry();
    wsTransport = new WsTransport({
      pool,
      eventBus,
      registry,
      getConfig: () => config,
    });
    const router = createRouter(pool, registry);

    server = Bun.serve({
      port: 0, // Random port
      hostname: '127.0.0.1',
      idleTimeout: 255,
      fetch(request: Request, server) {
        if (wsTransport.tryUpgrade(request, server)) {
          return undefined as any;
        }
        return router(request);
      },
      websocket: wsTransport.websocketHandler(),
    });

    port = server.port;
    wsTransport.startHeartbeat();
  });

  afterAll(async () => {
    wsTransport.shutdown();
    await pool.drainAll();
    server.stop();
  });

  // -----------------------------------------------------------------------
  // HTTP transport tests (verify existing functionality still works)
  // -----------------------------------------------------------------------

  describe('HTTP transport', () => {
    test('GET /health returns transport info', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.transports).toBeDefined();
      expect(body.transports.http).toBe('active');
      expect(body.transports.websocket).toBe('active');
    });

    test('HTTP routes still require auth', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // WebSocket transport tests
  // -----------------------------------------------------------------------

  describe('WebSocket transport', () => {
    test('WS upgrade on /ws path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS open timeout')), 5000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
      });

      ws.close();
    });

    test('WS upgrade on /rpc path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS open timeout')), 5000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
      });

      ws.close();
    });

    test('handshake with valid API key succeeds', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

      const ack = await wsHandshake(ws, apiKey, 'test-workspace');

      expect(ack.type).toBe('handshake_ack');
      expect(ack.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(ack.clientId).toBeDefined();
      expect(ack.clientId!.length).toBeGreaterThan(0);
      expect(ack.registeredChannels).toBeDefined();
      expect(ack.registeredChannels!.length).toBeGreaterThan(0);

      ws.close();
    });

    test('handshake without token is rejected', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

      const envelope: MessageEnvelope = {
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        // No token
      };
      ws.send(serializeEnvelope(envelope));

      // Should receive error and close
      const closePromise = new Promise<number>((resolve) => {
        ws.onclose = (event) => resolve(event.code);
      });

      const code = await closePromise;
      expect(code).toBe(4005);
    });

    test('handshake with invalid API key is rejected', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

      const envelope: MessageEnvelope = {
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token: 'craft_sk_invalid_key_that_does_not_exist',
      };
      ws.send(serializeEnvelope(envelope));

      const closePromise = new Promise<number>((resolve) => {
        ws.onclose = (event) => resolve(event.code);
      });

      const code = await closePromise;
      expect(code).toBe(4005);
    });

    test('handshake with wrong protocol version is rejected', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

      const envelope: MessageEnvelope = {
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '99.0', // Wrong version
        token: apiKey,
      };
      ws.send(serializeEnvelope(envelope));

      const closePromise = new Promise<number>((resolve) => {
        ws.onclose = (event) => resolve(event.code);
      });

      const code = await closePromise;
      expect(code).toBe(4004);
    });

    test('request to unknown channel returns error', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      await wsHandshake(ws, apiKey);

      const response = await wsRequest(ws, 'nonexistent:channel', []);

      expect(response.type).toBe('response');
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('CHANNEL_NOT_FOUND');

      ws.close();
    });

    test('sessions:get returns empty list', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      await wsHandshake(ws, apiKey);

      const response = await wsRequest(ws, 'sessions:get', []);

      expect(response.type).toBe('response');
      expect(response.error).toBeUndefined();
      expect(Array.isArray(response.result)).toBe(true);
      expect((response.result as any[]).length).toBe(0);

      ws.close();
    });

    test('client shows in registry after handshake', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      const ack = await wsHandshake(ws, apiKey);

      expect(registry.countByKind('websocket')).toBeGreaterThanOrEqual(1);
      expect(registry.get(ack.clientId!)).toBeDefined();

      ws.close();

      // Give the close event time to propagate
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('client removed from registry after disconnect', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      const ack = await wsHandshake(ws, apiKey);

      const clientId = ack.clientId!;
      expect(registry.get(clientId)).toBeDefined();

      ws.close();

      // Wait for close event to propagate
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(registry.get(clientId)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Dual-transport coexistence
  // -----------------------------------------------------------------------

  describe('dual-transport coexistence', () => {
    test('HTTP and WS work simultaneously on same port', async () => {
      // HTTP health check
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);

      // WS connection + handshake
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      const ack = await wsHandshake(ws, apiKey);
      expect(ack.type).toBe('handshake_ack');

      // Another HTTP request while WS is connected
      const healthRes2 = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await healthRes2.json();
      expect(body.transports.wsClients).toBeGreaterThanOrEqual(1);

      ws.close();
    });

    test('EventBus bridges events to WS clients', async () => {
      // Connect WS client
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      const ack = await wsHandshake(ws, apiKey);

      // Subscribe client to a session via the registry
      const client = registry.get(ack.clientId!);
      expect(client).toBeDefined();
      client!.subscribedSessions.add('test-session-123');

      // Collect events
      const eventsPromise = collectWsEvents(ws, 500);

      // Subscribe to EventBus (as WsTransport would) and publish an event
      const { unsubscribe } = eventBus.subscribe('test-session-123', (event) => {
        // Push to WS clients subscribed to this session
        registry.pushToSession('test-session-123', 'sessions:event', 'test-session-123', event);
      });

      eventBus.publish('test-session-123', { type: 'text_delta', text: 'hello from event bus' } as any);

      const events = await eventsPromise;
      unsubscribe();

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].channel).toBe('sessions:event');

      ws.close();
    });

    test('non-WS paths return normal HTTP responses', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'GET',
        headers: { 'Upgrade': 'websocket' }, // Sneaky header on non-WS path
      });

      // Should NOT upgrade — should return 401 (no auth)
      expect(res.status).toBe(401);
    });
  });
});
