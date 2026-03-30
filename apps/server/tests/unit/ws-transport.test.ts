import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { WsTransport } from '../../src/transport/ws-transport';
import { ClientRegistry } from '../../src/transport/client-registry';
import { EventBus } from '../../src/services/event-bus';
import { SessionPool } from '../../src/services/session-pool';
import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol';
import { serializeEnvelope, deserializeEnvelope } from '@craft-agent/server-core/transport';

describe('WsTransport', () => {
  let transport: WsTransport;
  let pool: SessionPool;
  let eventBus: EventBus;
  let registry: ClientRegistry;

  beforeEach(() => {
    eventBus = new EventBus();
    pool = new SessionPool(eventBus);
    registry = new ClientRegistry();
    transport = new WsTransport(pool, eventBus, registry);
  });

  afterEach(() => {
    transport.shutdown();
  });

  describe('websocketHandler', () => {
    test('returns handler object with open/message/close/drain', () => {
      const handler = transport.websocketHandler();
      expect(typeof handler.open).toBe('function');
      expect(typeof handler.message).toBe('function');
      expect(typeof handler.close).toBe('function');
      expect(typeof handler.drain).toBe('function');
    });
  });

  describe('tryUpgrade', () => {
    test('returns false for non-WS paths', () => {
      const request = new Request('http://localhost:3847/api/sessions', {
        headers: { 'Upgrade': 'websocket' },
      });
      const mockServer = { upgrade: mock(() => true) };
      expect(transport.tryUpgrade(request, mockServer as any)).toBe(false);
    });

    test('returns false without Upgrade header', () => {
      const request = new Request('http://localhost:3847/ws');
      const mockServer = { upgrade: mock(() => true) };
      expect(transport.tryUpgrade(request, mockServer as any)).toBe(false);
    });

    test('accepts /ws path with Upgrade header', () => {
      const request = new Request('http://localhost:3847/ws', {
        headers: { 'Upgrade': 'websocket' },
      });
      const mockServer = { upgrade: mock(() => true) };
      expect(transport.tryUpgrade(request, mockServer as any)).toBe(true);
      expect(mockServer.upgrade).toHaveBeenCalledTimes(1);
    });

    test('accepts /rpc path with Upgrade header', () => {
      const request = new Request('http://localhost:3847/rpc', {
        headers: { 'Upgrade': 'websocket' },
      });
      const mockServer = { upgrade: mock(() => true) };
      expect(transport.tryUpgrade(request, mockServer as any)).toBe(true);
      expect(mockServer.upgrade).toHaveBeenCalledTimes(1);
    });
  });

  describe('heartbeat', () => {
    test('startHeartbeat is idempotent', () => {
      transport.startHeartbeat();
      transport.startHeartbeat(); // Should not start a second timer
      transport.shutdown();
    });
  });

  describe('clientCount', () => {
    test('starts at 0', () => {
      expect(transport.clientCount).toBe(0);
    });
  });
});

describe('MessageEnvelope serialization (roundtrip)', () => {
  test('handshake envelope serializes and deserializes', () => {
    const envelope: MessageEnvelope = {
      id: '123',
      type: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      token: 'craft_sk_test',
      workspaceId: 'ws-1',
      clientCapabilities: ['sessions:event'],
    };

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized.id).toBe('123');
    expect(deserialized.type).toBe('handshake');
    expect(deserialized.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(deserialized.token).toBe('craft_sk_test');
    expect(deserialized.workspaceId).toBe('ws-1');
  });

  test('request envelope serializes and deserializes', () => {
    const envelope: MessageEnvelope = {
      id: '456',
      type: 'request',
      channel: 'sessions:create',
      args: [{ workspaceId: 'ws-1', model: 'claude-sonnet-4-6' }],
    };

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized.type).toBe('request');
    expect(deserialized.channel).toBe('sessions:create');
    expect(deserialized.args?.[0]).toEqual({ workspaceId: 'ws-1', model: 'claude-sonnet-4-6' });
  });

  test('event envelope serializes and deserializes', () => {
    const envelope: MessageEnvelope = {
      id: '789',
      type: 'event',
      channel: 'sessions:event',
      args: ['session-1', { type: 'text_delta', text: 'hello' }],
      serverId: 'http-trigger',
    };

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized.type).toBe('event');
    expect(deserialized.channel).toBe('sessions:event');
    expect(deserialized.args).toHaveLength(2);
    expect(deserialized.serverId).toBe('http-trigger');
  });

  test('error envelope serializes and deserializes', () => {
    const envelope: MessageEnvelope = {
      id: 'err-1',
      type: 'error',
      error: { code: 'AUTH_FAILED', message: 'Invalid token' },
    };

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized.type).toBe('error');
    expect(deserialized.error?.code).toBe('AUTH_FAILED');
    expect(deserialized.error?.message).toBe('Invalid token');
  });

  test('response with error serializes and deserializes', () => {
    const envelope: MessageEnvelope = {
      id: 'resp-err',
      type: 'response',
      channel: 'sessions:create',
      error: { code: 'HANDLER_ERROR', message: 'workspaceId is required' },
    };

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(deserialized.type).toBe('response');
    expect(deserialized.error?.code).toBe('HANDLER_ERROR');
  });

  test('invalid JSON throws', () => {
    expect(() => deserializeEnvelope('not json')).toThrow();
  });

  test('missing required fields throws', () => {
    expect(() => deserializeEnvelope(JSON.stringify({ foo: 'bar' }))).toThrow('Invalid envelope shape');
  });
});
