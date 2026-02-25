import { describe, test, expect, beforeEach } from 'bun:test';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';
import type { AgentEvent } from '@craft-agent/core/types';

/**
 * Minimal mock session for lifecycle testing.
 */
class LifecycleMockSession {
  readonly sessionId: string;
  readonly workspace = { id: 'ws-1', name: 'Test', rootPath: '/tmp' };
  private _status: 'idle' | 'processing' | 'disposed' = 'idle';
  private _lastActivityAt = Date.now();
  private _aborted = false;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async initialize() {}
  getStatus() { return this._status; }
  getSdkSessionId() { return `sdk-${this.sessionId}`; }
  getLastActivityAt() { return this._lastActivityAt; }
  setCallbacks() {}
  respondToPermission() {}
  getAgent() { return null; }
  getOrchestrator() { return null as any; }

  async *chat(message: string): AsyncGenerator<AgentEvent> {
    this._status = 'processing';
    this._lastActivityAt = Date.now();
    this._aborted = false;

    yield { type: 'text_delta', text: `Echo: ${message}` } as AgentEvent;

    // Check if aborted between events
    if (this._aborted) {
      this._status = 'idle';
      return;
    }

    yield { type: 'text_complete', text: `Echo: ${message}` } as AgentEvent;
    yield { type: 'complete' } as AgentEvent;
    this._status = 'idle';
  }

  abort() {
    this._aborted = true;
    if (this._status === 'processing') {
      this._status = 'idle';
    }
  }

  dispose() {
    this._status = 'disposed';
  }
}

/**
 * Inject a mock session into a SessionPool.
 */
function injectSession(pool: SessionPool, apiKeyId: string, sessionId?: string): LifecycleMockSession {
  const session = new LifecycleMockSession(sessionId);
  const sessions = (pool as any).sessions as Map<string, any>;
  sessions.set(session.sessionId, {
    session,
    apiKeyId,
    createdAt: Date.now(),
  });
  (pool as any).totalCreated++;
  return session;
}

describe('Session Lifecycle', () => {
  let bus: EventBus;
  let pool: SessionPool;

  beforeEach(() => {
    bus = new EventBus();
    pool = new SessionPool(bus);
  });

  describe('Full lifecycle', () => {
    test('create → chat → idle → chat → delete', async () => {
      const session = injectSession(pool, 'key-1');
      expect(session.getStatus()).toBe('idle');
      expect(pool.activeCount).toBe(1);

      // First chat
      const events1: AgentEvent[] = [];
      for await (const event of session.chat('hello')) {
        events1.push(event);
      }
      expect(events1).toHaveLength(3);
      expect(session.getStatus()).toBe('idle');

      // Second chat (conversation continuity)
      const events2: AgentEvent[] = [];
      for await (const event of session.chat('world')) {
        events2.push(event);
      }
      expect(events2).toHaveLength(3);
      expect(session.getStatus()).toBe('idle');

      // Delete
      pool.remove(session.sessionId);
      expect(pool.activeCount).toBe(0);
      expect(session.getStatus()).toBe('disposed');
    });

    test('create → chat → abort → idle', async () => {
      const session = injectSession(pool, 'key-1');

      // Start chat and abort after first event
      const events: AgentEvent[] = [];
      for await (const event of session.chat('hello')) {
        events.push(event);
        if (events.length === 1) {
          session.abort();
        }
      }

      // Should have stopped early
      expect(events.length).toBeLessThanOrEqual(2);
      expect(session.getStatus()).toBe('idle');
    });
  });

  describe('EventBus integration', () => {
    test('events published to bus are received by subscribers', async () => {
      const session = injectSession(pool, 'key-1');
      const received: AgentEvent[] = [];

      bus.subscribe(session.sessionId, (event) => received.push(event));

      for await (const event of session.chat('test')) {
        bus.publish(session.sessionId, event);
      }

      expect(received).toHaveLength(3);
      expect(received[0].type).toBe('text_delta');
      expect(received[2].type).toBe('complete');
    });

    test('removing session cleans up EventBus subscribers', () => {
      const session = injectSession(pool, 'key-1');

      bus.subscribe(session.sessionId, () => {});
      bus.subscribe(session.sessionId, () => {});
      expect(bus.subscriberCount(session.sessionId)).toBe(2);

      pool.remove(session.sessionId);
      expect(bus.subscriberCount(session.sessionId)).toBe(0);
    });

    test('drainAll cleans up all EventBus subscribers', async () => {
      const s1 = injectSession(pool, 'key-1');
      const s2 = injectSession(pool, 'key-2');

      bus.subscribe(s1.sessionId, () => {});
      bus.subscribe(s2.sessionId, () => {});

      await pool.drainAll();

      expect(bus.subscriberCount(s1.sessionId)).toBe(0);
      expect(bus.subscriberCount(s2.sessionId)).toBe(0);
    });
  });

  describe('Concurrent isolation', () => {
    test('sessions from different API keys are isolated', async () => {
      const s1 = injectSession(pool, 'key-1');
      const s2 = injectSession(pool, 'key-2');

      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];

      bus.subscribe(s1.sessionId, (e) => events1.push(e));
      bus.subscribe(s2.sessionId, (e) => events2.push(e));

      // Chat on both sessions concurrently
      await Promise.all([
        (async () => {
          for await (const e of s1.chat('msg 1')) bus.publish(s1.sessionId, e);
        })(),
        (async () => {
          for await (const e of s2.chat('msg 2')) bus.publish(s2.sessionId, e);
        })(),
      ]);

      // Each session should get its own events
      expect(events1.every(e => e.type !== 'text_delta' || (e as any).text?.includes('msg 1'))).toBe(true);
      expect(events2.every(e => e.type !== 'text_delta' || (e as any).text?.includes('msg 2'))).toBe(true);
    });

    test('removing one session does not affect others', () => {
      const s1 = injectSession(pool, 'key-1');
      const s2 = injectSession(pool, 'key-1');

      pool.remove(s1.sessionId);

      expect(pool.has(s1.sessionId)).toBe(false);
      expect(pool.has(s2.sessionId)).toBe(true);
      expect(pool.activeCount).toBe(1);
    });
  });

  describe('Eviction', () => {
    test('only evicts idle sessions past threshold', () => {
      const old = injectSession(pool, 'key-1');
      const recent = injectSession(pool, 'key-1');

      // Make one session old
      (old as any)._lastActivityAt = Date.now() - 120_000; // 2 minutes ago

      const evicted = pool.evictIdle(60_000); // 1 minute threshold
      expect(evicted).toEqual([old.sessionId]);
      expect(pool.has(old.sessionId)).toBe(false);
      expect(pool.has(recent.sessionId)).toBe(true);
    });

    test('does not evict processing sessions', () => {
      const session = injectSession(pool, 'key-1');
      (session as any)._status = 'processing';
      (session as any)._lastActivityAt = Date.now() - 120_000;

      const evicted = pool.evictIdle(60_000);
      expect(evicted).toHaveLength(0);
      expect(pool.has(session.sessionId)).toBe(true);
    });

    test('eviction updates stats', () => {
      const session = injectSession(pool, 'key-1');
      (session as any)._lastActivityAt = Date.now() - 120_000;

      expect(pool.stats.totalEvicted).toBe(0);
      pool.evictIdle(60_000);
      expect(pool.stats.totalEvicted).toBe(1);
    });
  });

  describe('Error recovery', () => {
    test('pool.get returns undefined for non-existent session', () => {
      expect(pool.get('nonexistent')).toBeUndefined();
    });

    test('pool.remove is safe for non-existent session', () => {
      // Should not throw
      pool.remove('nonexistent');
    });

    test('pool.has returns false for non-existent session', () => {
      expect(pool.has('nonexistent')).toBe(false);
    });

    test('listSessions returns empty array when no sessions', () => {
      expect(pool.listSessions()).toEqual([]);
    });

    test('drainAll is safe with no sessions', async () => {
      await pool.drainAll(); // Should not throw
      expect(pool.activeCount).toBe(0);
    });
  });
});
