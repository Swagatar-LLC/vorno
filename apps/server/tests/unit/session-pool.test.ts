import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';

// Note: Full SessionPool tests require mocking AgentSession/CraftAgent
// These tests verify the pool management logic with simulated sessions

describe('SessionPool', () => {
  let eventBus: EventBus;
  let pool: SessionPool;

  beforeEach(() => {
    eventBus = new EventBus();
    pool = new SessionPool(eventBus);
  });

  test('starts with zero active sessions', () => {
    expect(pool.activeCount).toBe(0);
    expect(pool.stats.totalCreated).toBe(0);
    expect(pool.stats.totalEvicted).toBe(0);
  });

  test('listSessions returns empty initially', () => {
    expect(pool.listSessions()).toHaveLength(0);
  });

  test('has returns false for non-existent session', () => {
    expect(pool.has('nonexistent')).toBe(false);
  });

  test('get returns undefined for non-existent session', () => {
    expect(pool.get('nonexistent')).toBeUndefined();
  });

  test('countByApiKey returns 0 when no sessions', () => {
    expect(pool.countByApiKey('key-1')).toBe(0);
  });

  test('evictIdle returns empty when no sessions', () => {
    const evicted = pool.evictIdle(1000);
    expect(evicted).toHaveLength(0);
  });

  test('drainAll resolves when no sessions', async () => {
    await pool.drainAll();
    expect(pool.activeCount).toBe(0);
  });

  test('getEventBus returns the event bus', () => {
    expect(pool.getEventBus()).toBe(eventBus);
  });

  test('stats reflect pool state', () => {
    const stats = pool.stats;
    expect(stats).toEqual({
      activeCount: 0,
      totalCreated: 0,
      totalEvicted: 0,
    });
  });
});
