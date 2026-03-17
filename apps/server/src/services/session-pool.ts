import { AgentSession, type AgentSessionConfig } from '../orchestrator/index.ts';
import { EventBus } from './event-bus.ts';

export interface PoolStats {
  activeCount: number;
  totalCreated: number;
  totalEvicted: number;
}

interface ManagedPoolEntry {
  session: AgentSession;
  apiKeyId: string;
  createdAt: number;
}

/**
 * Manages active AgentSession instances with lifecycle management.
 * Enforces concurrency limits per API key and idle eviction.
 */
export class SessionPool {
  private sessions: Map<string, ManagedPoolEntry> = new Map();
  private eventBus: EventBus;
  private totalCreated = 0;
  private totalEvicted = 0;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Create a new session and add it to the pool.
   * Returns the created AgentSession.
   */
  async create(config: AgentSessionConfig, apiKeyId: string): Promise<AgentSession> {
    const session = new AgentSession(config);
    await session.initialize();

    this.sessions.set(session.sessionId, {
      session,
      apiKeyId,
      createdAt: Date.now(),
    });
    this.totalCreated++;

    return session;
  }

  /**
   * Get an active session by ID.
   */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * Check if a session exists in the pool.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Remove a session from the pool and dispose it.
   */
  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.dispose();
      this.eventBus.removeSession(sessionId);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Count sessions for a specific API key.
   */
  countByApiKey(apiKeyId: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.apiKeyId === apiKeyId) count++;
    }
    return count;
  }

  /**
   * Evict idle sessions that haven't been active for the given duration.
   * Returns the IDs of evicted sessions.
   */
  evictIdle(maxIdleMs: number): string[] {
    const now = Date.now();
    const evicted: string[] = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.session.getStatus() === 'idle' &&
          now - entry.session.getLastActivityAt() > maxIdleMs) {
        entry.session.dispose();
        this.eventBus.removeSession(sessionId);
        this.sessions.delete(sessionId);
        evicted.push(sessionId);
        this.totalEvicted++;
      }
    }

    return evicted;
  }

  /**
   * Gracefully shutdown all sessions.
   */
  async drainAll(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    for (const [sessionId, entry] of this.sessions) {
      entry.session.abort();
      // Give abort a moment to take effect
      disposePromises.push(
        new Promise<void>(resolve => {
          setTimeout(() => {
            entry.session.dispose();
            this.eventBus.removeSession(sessionId);
            resolve();
          }, 100);
        })
      );
    }

    await Promise.all(disposePromises);
    this.sessions.clear();
  }

  /**
   * Get the number of active sessions.
   */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Get pool statistics.
   */
  get stats(): PoolStats {
    return {
      activeCount: this.sessions.size,
      totalCreated: this.totalCreated,
      totalEvicted: this.totalEvicted,
    };
  }

  /**
   * List all session IDs with their status and API key.
   */
  listSessions(): Array<{ sessionId: string; status: string; apiKeyId: string; createdAt: number }> {
    const result: Array<{ sessionId: string; status: string; apiKeyId: string; createdAt: number }> = [];
    for (const [sessionId, entry] of this.sessions) {
      result.push({
        sessionId,
        status: entry.session.getStatus(),
        apiKeyId: entry.apiKeyId,
        createdAt: entry.createdAt,
      });
    }
    return result;
  }

  /**
   * Get the EventBus instance.
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }
}
