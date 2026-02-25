import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventBus } from '../../src/services/event-bus';
import { SessionPool } from '../../src/services/session-pool';
import type { AgentEvent } from '@craft-agent/core/types';

/**
 * Mock AgentSession that yields canned events without real API calls.
 */
class MockAgentSession {
  readonly sessionId: string;
  readonly workspace: any;
  private _status: 'idle' | 'processing' | 'disposed' = 'idle';
  private _lastActivityAt = Date.now();
  private _sdkSessionId: string | undefined = 'mock-sdk-123';
  private _chatEvents: AgentEvent[];
  private _shouldThrow = false;
  private _callbacks: any = {};

  constructor(opts?: { sessionId?: string; events?: AgentEvent[]; shouldThrow?: boolean }) {
    this.sessionId = opts?.sessionId ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.workspace = { id: 'test-ws', name: 'Test', rootPath: '/tmp' };
    this._chatEvents = opts?.events ?? [
      { type: 'text_delta', text: 'Hello ' } as AgentEvent,
      { type: 'text_delta', text: 'world' } as AgentEvent,
      { type: 'text_complete', text: 'Hello world' } as AgentEvent,
      { type: 'usage_update', inputTokens: 10, outputTokens: 5 } as AgentEvent,
      { type: 'complete' } as AgentEvent,
    ];
    this._shouldThrow = opts?.shouldThrow ?? false;
  }

  async initialize() { /* no-op */ }
  getStatus() { return this._status; }
  getSdkSessionId() { return this._sdkSessionId; }
  getLastActivityAt() { return this._lastActivityAt; }
  setCallbacks(cb: any) { this._callbacks = cb; }

  async *chat(message: string): AsyncGenerator<AgentEvent> {
    this._status = 'processing';
    this._lastActivityAt = Date.now();

    if (this._shouldThrow) {
      this._status = 'idle';
      throw new Error('Mock SDK crash');
    }

    for (const event of this._chatEvents) {
      yield event;
      if (event.type === 'complete') break;
    }
    this._status = 'idle';
  }

  respondToPermission() {}

  abort() {
    if (this._status === 'processing') {
      this._status = 'idle';
    }
  }

  dispose() {
    this._status = 'disposed';
  }

  getAgent() { return null; }
  getOrchestrator() { return null as any; }
}

// ─── EventBus + SSE Pipeline Tests ────────────────────────────

describe('Mock Agent Integration', () => {
  describe('EventBus → SSE pipeline', () => {
    test('events flow through EventBus in correct order', async () => {
      const bus = new EventBus();
      const received: AgentEvent[] = [];

      bus.subscribe('session-1', (event) => received.push(event));

      const session = new MockAgentSession({ sessionId: 'session-1' });

      for await (const event of session.chat('test')) {
        bus.publish('session-1', event);
      }

      expect(received).toHaveLength(5);
      expect(received[0].type).toBe('text_delta');
      expect(received[1].type).toBe('text_delta');
      expect(received[2].type).toBe('text_complete');
      expect(received[3].type).toBe('usage_update');
      expect(received[4].type).toBe('complete');
    });

    test('SSE format is correct for each event type', async () => {
      const bus = new EventBus();
      const sseLines: string[] = [];

      bus.subscribe('session-1', (event) => {
        const sseLine = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        sseLines.push(sseLine);
      });

      const session = new MockAgentSession({ sessionId: 'session-1' });
      for await (const event of session.chat('test')) {
        bus.publish('session-1', event);
      }

      // Verify SSE format
      for (const line of sseLines) {
        expect(line).toMatch(/^event: \w+\ndata: \{.*\}\n\n$/);
      }

      // Verify each event can be parsed from SSE
      for (const line of sseLines) {
        const dataMatch = line.match(/data: (.+)\n/);
        expect(dataMatch).not.toBeNull();
        const parsed = JSON.parse(dataMatch![1]);
        expect(parsed.type).toBeDefined();
      }
    });

    test('multiple concurrent sessions produce isolated event streams', async () => {
      const bus = new EventBus();
      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];

      bus.subscribe('s1', (e) => events1.push(e));
      bus.subscribe('s2', (e) => events2.push(e));

      const session1 = new MockAgentSession({
        sessionId: 's1',
        events: [
          { type: 'text_delta', text: 'from session 1' } as AgentEvent,
          { type: 'complete' } as AgentEvent,
        ],
      });

      const session2 = new MockAgentSession({
        sessionId: 's2',
        events: [
          { type: 'text_delta', text: 'from session 2' } as AgentEvent,
          { type: 'complete' } as AgentEvent,
        ],
      });

      // Run concurrently
      await Promise.all([
        (async () => {
          for await (const event of session1.chat('test')) {
            bus.publish('s1', event);
          }
        })(),
        (async () => {
          for await (const event of session2.chat('test')) {
            bus.publish('s2', event);
          }
        })(),
      ]);

      expect(events1).toHaveLength(2);
      expect(events2).toHaveLength(2);
      expect((events1[0] as any).text).toBe('from session 1');
      expect((events2[0] as any).text).toBe('from session 2');
    });
  });

  describe('Session lifecycle', () => {
    test('session transitions: idle → processing → idle', async () => {
      const session = new MockAgentSession();
      expect(session.getStatus()).toBe('idle');

      const events: AgentEvent[] = [];
      for await (const event of session.chat('test')) {
        if (events.length === 0) {
          // First event — session should be processing
          expect(session.getStatus()).toBe('processing');
        }
        events.push(event);
      }

      expect(session.getStatus()).toBe('idle');
      expect(events.length).toBeGreaterThan(0);
    });

    test('session abort during processing returns to idle', () => {
      const session = new MockAgentSession();
      // Manually set to processing to simulate in-progress state
      (session as any)._status = 'processing';
      expect(session.getStatus()).toBe('processing');

      session.abort();
      expect(session.getStatus()).toBe('idle');
    });

    test('dispose marks session as disposed', () => {
      const session = new MockAgentSession();
      expect(session.getStatus()).toBe('idle');

      session.dispose();
      expect(session.getStatus()).toBe('disposed');
    });

    test('chat error returns session to idle', async () => {
      const session = new MockAgentSession({ shouldThrow: true });

      let threw = false;
      try {
        for await (const event of session.chat('test')) {
          // Should not reach here
        }
      } catch (e: any) {
        threw = true;
        expect(e.message).toBe('Mock SDK crash');
      }

      expect(threw).toBe(true);
      expect(session.getStatus()).toBe('idle');
    });

    test('SDK session ID is available', () => {
      const session = new MockAgentSession();
      expect(session.getSdkSessionId()).toBe('mock-sdk-123');
    });

    test('lastActivityAt updates during chat', async () => {
      const session = new MockAgentSession();
      const before = session.getLastActivityAt();

      // Small delay to ensure timestamp changes
      await new Promise(r => setTimeout(r, 5));

      for await (const event of session.chat('test')) {
        // consume
      }

      expect(session.getLastActivityAt()).toBeGreaterThanOrEqual(before);
    });
  });

  describe('Pool operations with mock sessions', () => {
    let bus: EventBus;

    beforeEach(() => {
      bus = new EventBus();
    });

    test('pool stats track created sessions', () => {
      const pool = createMockPool(bus);
      expect(pool.stats.activeCount).toBe(0);
      expect(pool.stats.totalCreated).toBe(0);

      addMockSession(pool, bus, 'key-1');
      expect(pool.stats.activeCount).toBe(1);
      expect(pool.stats.totalCreated).toBe(1);

      addMockSession(pool, bus, 'key-1');
      expect(pool.stats.activeCount).toBe(2);
      expect(pool.stats.totalCreated).toBe(2);
    });

    test('countByApiKey returns correct count', () => {
      const pool = createMockPool(bus);

      addMockSession(pool, bus, 'key-1');
      addMockSession(pool, bus, 'key-1');
      addMockSession(pool, bus, 'key-2');

      expect(pool.countByApiKey('key-1')).toBe(2);
      expect(pool.countByApiKey('key-2')).toBe(1);
      expect(pool.countByApiKey('key-3')).toBe(0);
    });

    test('remove disposes and removes session', () => {
      const pool = createMockPool(bus);
      const session = addMockSession(pool, bus, 'key-1');

      expect(pool.has(session.sessionId)).toBe(true);

      pool.remove(session.sessionId);

      expect(pool.has(session.sessionId)).toBe(false);
      expect(session.getStatus()).toBe('disposed');
      expect(pool.stats.activeCount).toBe(0);
    });

    test('listSessions returns all sessions', () => {
      const pool = createMockPool(bus);
      addMockSession(pool, bus, 'key-1');
      addMockSession(pool, bus, 'key-2');

      const list = pool.listSessions();
      expect(list).toHaveLength(2);
      expect(list.every(s => s.status === 'idle')).toBe(true);
    });

    test('drainAll disposes all sessions', async () => {
      const pool = createMockPool(bus);
      const s1 = addMockSession(pool, bus, 'key-1');
      const s2 = addMockSession(pool, bus, 'key-2');

      await pool.drainAll();

      expect(pool.activeCount).toBe(0);
      expect(s1.getStatus()).toBe('disposed');
      expect(s2.getStatus()).toBe('disposed');
    });

    test('evictIdle removes old idle sessions', () => {
      const pool = createMockPool(bus);
      const session = addMockSession(pool, bus, 'key-1');

      // Set lastActivityAt to the past
      (session as any)._lastActivityAt = Date.now() - 60_000;

      const evicted = pool.evictIdle(30_000); // 30s threshold
      expect(evicted).toHaveLength(1);
      expect(evicted[0]).toBe(session.sessionId);
      expect(pool.activeCount).toBe(0);
    });

    test('evictIdle keeps recent sessions', () => {
      const pool = createMockPool(bus);
      addMockSession(pool, bus, 'key-1');

      const evicted = pool.evictIdle(30_000);
      expect(evicted).toHaveLength(0);
      expect(pool.activeCount).toBe(1);
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Create a SessionPool that we can manually add mock sessions to.
 * We access the private sessions map for testing.
 */
function createMockPool(bus: EventBus): SessionPool {
  return new SessionPool(bus);
}

/**
 * Manually insert a mock session into the pool (bypassing real AgentSession creation).
 */
function addMockSession(pool: SessionPool, bus: EventBus, apiKeyId: string): MockAgentSession {
  const session = new MockAgentSession();

  // Access private members to inject mock session
  const sessions = (pool as any).sessions as Map<string, any>;
  sessions.set(session.sessionId, {
    session,
    apiKeyId,
    createdAt: Date.now(),
  });
  (pool as any).totalCreated++;

  return session;
}
