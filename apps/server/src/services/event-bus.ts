import type { AgentEvent } from '@craft-agent/core/types';

type Subscriber = {
  id: string;
  callback: (event: AgentEvent) => void;
};

/**
 * In-process pub/sub for routing AgentEvents to SSE connections.
 * Each session can have multiple subscribers (e.g., multiple SSE clients).
 */
export class EventBus {
  private subscribers: Map<string, Subscriber[]> = new Map();
  private subscriberIdCounter = 0;

  /**
   * Subscribe to events for a session.
   * Returns an unsubscribe function and a subscriber ID.
   */
  subscribe(sessionId: string, callback: (event: AgentEvent) => void): {
    subscriberId: string;
    unsubscribe: () => void;
  } {
    const subscriberId = `sub_${++this.subscriberIdCounter}`;
    const subscriber: Subscriber = { id: subscriberId, callback };

    const subs = this.subscribers.get(sessionId) ?? [];
    subs.push(subscriber);
    this.subscribers.set(sessionId, subs);

    return {
      subscriberId,
      unsubscribe: () => this.unsubscribe(sessionId, subscriberId),
    };
  }

  /**
   * Publish an event to all subscribers for a session.
   */
  publish(sessionId: string, event: AgentEvent): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    for (const sub of subs) {
      try {
        sub.callback(event);
      } catch {
        // Subscriber error - don't let one bad subscriber break others
      }
    }
  }

  /**
   * Unsubscribe by subscriber ID.
   */
  unsubscribe(sessionId: string, subscriberId: string): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    const filtered = subs.filter(s => s.id !== subscriberId);
    if (filtered.length === 0) {
      this.subscribers.delete(sessionId);
    } else {
      this.subscribers.set(sessionId, filtered);
    }
  }

  /**
   * Remove all subscribers for a session (session deleted/cleaned up).
   */
  removeSession(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  /**
   * Get the number of subscribers for a session.
   */
  subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.length ?? 0;
  }

  /**
   * Get total subscriber count across all sessions.
   */
  totalSubscribers(): number {
    let count = 0;
    for (const subs of this.subscribers.values()) {
      count += subs.length;
    }
    return count;
  }
}
