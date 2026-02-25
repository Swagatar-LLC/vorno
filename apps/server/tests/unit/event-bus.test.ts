import { describe, test, expect } from 'bun:test';
import { EventBus } from '../../src/services/event-bus';
import type { AgentEvent } from '@craft-agent/core/types';

describe('EventBus', () => {
  test('subscribe and publish', () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe('session-1', (event) => {
      received.push(event);
    });

    const event: AgentEvent = { type: 'text_delta', text: 'hello' };
    bus.publish('session-1', event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  test('multiple subscribers receive same event', () => {
    const bus = new EventBus();
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    bus.subscribe('session-1', (event) => received1.push(event));
    bus.subscribe('session-1', (event) => received2.push(event));

    const event: AgentEvent = { type: 'text_delta', text: 'hello' };
    bus.publish('session-1', event);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test('events are session-scoped', () => {
    const bus = new EventBus();
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    bus.subscribe('session-1', (event) => received1.push(event));
    bus.subscribe('session-2', (event) => received2.push(event));

    bus.publish('session-1', { type: 'text_delta', text: 'for session 1' });
    bus.publish('session-2', { type: 'text_delta', text: 'for session 2' });

    expect(received1).toHaveLength(1);
    expect(received1[0].type).toBe('text_delta');
    expect(received2).toHaveLength(1);
    expect(received2[0].type).toBe('text_delta');
  });

  test('unsubscribe stops events', () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    const { unsubscribe } = bus.subscribe('session-1', (event) => {
      received.push(event);
    });

    bus.publish('session-1', { type: 'text_delta', text: 'before' });
    expect(received).toHaveLength(1);

    unsubscribe();

    bus.publish('session-1', { type: 'text_delta', text: 'after' });
    expect(received).toHaveLength(1); // Still 1
  });

  test('removeSession cleans up all subscribers', () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe('session-1', (event) => received.push(event));
    bus.subscribe('session-1', (event) => received.push(event));

    expect(bus.subscriberCount('session-1')).toBe(2);

    bus.removeSession('session-1');

    expect(bus.subscriberCount('session-1')).toBe(0);

    bus.publish('session-1', { type: 'text_delta', text: 'after remove' });
    expect(received).toHaveLength(0);
  });

  test('subscriberCount returns correct count', () => {
    const bus = new EventBus();

    expect(bus.subscriberCount('session-1')).toBe(0);

    bus.subscribe('session-1', () => {});
    expect(bus.subscriberCount('session-1')).toBe(1);

    bus.subscribe('session-1', () => {});
    expect(bus.subscriberCount('session-1')).toBe(2);

    bus.subscribe('session-2', () => {});
    expect(bus.subscriberCount('session-2')).toBe(1);
  });

  test('totalSubscribers counts across sessions', () => {
    const bus = new EventBus();

    expect(bus.totalSubscribers()).toBe(0);

    bus.subscribe('session-1', () => {});
    bus.subscribe('session-1', () => {});
    bus.subscribe('session-2', () => {});

    expect(bus.totalSubscribers()).toBe(3);
  });

  test('bad subscriber does not break others', () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe('session-1', () => {
      throw new Error('bad subscriber');
    });
    bus.subscribe('session-1', (event) => received.push(event));

    bus.publish('session-1', { type: 'text_delta', text: 'hello' });

    expect(received).toHaveLength(1);
  });

  test('publish to non-existent session is no-op', () => {
    const bus = new EventBus();
    // Should not throw
    bus.publish('nonexistent', { type: 'text_delta', text: 'hello' });
  });
});
