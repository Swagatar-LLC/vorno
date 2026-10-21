/**
 * WsProtocol close-code parity tests (PLAN-012 / ADR-0007).
 *
 * The protocol is runtime-neutral: Bun's ServerWebSocket and the embedded host's
 * node `ws` socket both drive it through the WsSocketAdapter seam. These tests
 * exercise the protocol directly with an in-memory fake socket, so the WS close
 * codes (4001–4005 + 1001) are guaranteed identical across both runtimes without
 * standing up either server.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WsProtocol } from '../../src/transport/ws-protocol';
import { createWsClientData, type WsSocketAdapter } from '../../src/transport/ws-socket';
import { ClientRegistry } from '../../src/transport/client-registry';
import { EventBus } from '../../src/services/event-bus';
import { SessionPool } from '../../src/services/session-pool';
import { PROTOCOL_VERSION, type MessageEnvelope } from '@craft-agent/shared/protocol';
import { serializeEnvelope, deserializeEnvelope } from '@craft-agent/server-core/transport';
import type { ServerConfig } from '../../src/config';

/** In-memory socket capturing sent frames and close code/reason. */
class FakeSocket implements WsSocketAdapter {
  readonly data = createWsClientData('client-test');
  sent: MessageEnvelope[] = [];
  closed: { code: number; reason: string } | null = null;
  pings = 0;
  send(data: string): void {
    this.sent.push(deserializeEnvelope(data));
  }
  close(code: number, reason: string): void {
    if (!this.closed) this.closed = { code, reason };
  }
  ping(): void {
    this.pings++;
  }
}

const EMPTY_CONFIG: ServerConfig = {
  enabled: true,
  port: 3847,
  host: '127.0.0.1',
  apiKeys: [],
  rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
};

describe('WsProtocol close codes (runtime-neutral)', () => {
  let protocol: WsProtocol;
  let sock: FakeSocket;

  beforeEach(() => {
    const eventBus = new EventBus();
    const pool = new SessionPool(eventBus);
    const registry = new ClientRegistry();
    protocol = new WsProtocol({ pool, eventBus, registry, getConfig: () => EMPTY_CONFIG });
    sock = new FakeSocket();
  });

  afterEach(() => {
    protocol.shutdown();
  });

  async function send(envelope: MessageEnvelope) {
    await protocol.handleMessage(sock, serializeEnvelope(envelope));
  }

  test('4002 on invalid message format', async () => {
    await protocol.handleMessage(sock, 'not-a-valid-envelope');
    expect(sock.closed?.code).toBe(4002);
  });

  test('4003 when first message is not a handshake', async () => {
    await send({ id: '1', type: 'request', channel: 'sessions:get' });
    expect(sock.closed?.code).toBe(4003);
  });

  test('4004 when handshake omits protocolVersion', async () => {
    await send({ id: '1', type: 'handshake', token: 'craft_sk_x' } as MessageEnvelope);
    expect(sock.closed?.code).toBe(4004);
  });

  test('4004 on protocol major-version mismatch', async () => {
    const major = parseInt(PROTOCOL_VERSION.split('.')[0], 10);
    await send({ id: '1', type: 'handshake', protocolVersion: `${major + 1}.0.0`, token: 'craft_sk_x' });
    expect(sock.closed?.code).toBe(4004);
  });

  test('4005 when handshake omits token', async () => {
    await send({ id: '1', type: 'handshake', protocolVersion: PROTOCOL_VERSION });
    expect(sock.closed?.code).toBe(4005);
  });

  test('4005 on invalid API key', async () => {
    await send({ id: '1', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: 'craft_sk_bogus' });
    expect(sock.closed?.code).toBe(4005);
    const err = sock.sent.find((e) => e.type === 'error');
    expect(err?.error?.code).toBe('AUTH_FAILED');
  });

  test('shutdown on an idle protocol is a safe no-op', () => {
    expect(protocol.clientCount).toBe(0);
    protocol.shutdown();
    expect(protocol.clientCount).toBe(0);
  });
});

// fork(PLAN-057): routed (desktop) sessions share the pool, so WS session RPCs
// must enforce the same per-key ownership the REST routes do.
describe('WsProtocol session ownership', () => {
  test('another key cannot delete, message, cancel or answer a session', async () => {
    const { generateApiKey } = await import('../../src/config');
    const keyA = generateApiKey('ws-a', { workspaceIds: [], permissionPolicy: 'allow-all', maxConcurrentSessions: 2 });
    const keyB = generateApiKey('ws-b', { workspaceIds: [], permissionPolicy: 'allow-all', maxConcurrentSessions: 2 });
    const config: ServerConfig = { ...EMPTY_CONFIG, apiKeys: [keyA.stored, keyB.stored] };
    const eventBus = new EventBus();
    const pool = new SessionPool(eventBus);
    const calls: string[] = [];
    pool.adopt({
      sessionId: 'owned-by-a',
      getStatus: () => 'idle',
      getSdkSessionId: () => undefined,
      getLastActivityAt: () => Date.now(),
      async *chat() { calls.push('chat'); },
      abort: () => { calls.push('abort'); },
      dispose: () => { calls.push('dispose'); },
      respondToPermission: () => { calls.push('respond'); return true; },
    }, keyA.stored.id);
    const protocol = new WsProtocol({ pool, eventBus, registry: new ClientRegistry(), getConfig: () => config });
    const sock = new FakeSocket();
    const send = (envelope: MessageEnvelope) => protocol.handleMessage(sock, serializeEnvelope(envelope));
    await send({ id: 'h', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: keyB.fullKey } as MessageEnvelope);
    const requests: Array<[string, unknown[]]> = [
      ['sessions:delete', ['owned-by-a']],
      ['sessions:sendMessage', [{ sessionId: 'owned-by-a', content: 'hi' }]],
      ['sessions:cancel', ['owned-by-a']],
      ['sessions:respondToPermission', [{ sessionId: 'owned-by-a', requestId: 'r', allowed: true }]],
    ];
    for (const [channel, args] of requests) {
      await send({ id: channel, type: 'request', channel, args } as MessageEnvelope);
    }
    const errors = sock.sent.filter((e) => e.type === 'response' && (e as { error?: unknown }).error);
    expect(errors.length).toBe(requests.length);
    expect(calls).toEqual([]);
    expect(pool.has('owned-by-a')).toBe(true);
    protocol.shutdown();
  });
});
