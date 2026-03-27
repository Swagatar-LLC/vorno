/**
 * ClientRegistry — unified tracking for WebSocket and HTTP/SSE clients.
 *
 * Both transports register their clients here so that event push routing
 * can target clients by ID, workspace, or broadcast to all.
 */

import type { PushTarget } from '@craft-agent/shared/protocol';
import type { TransportClient, TransportKind } from './types.ts';

/**
 * Callback to deliver a push event to a specific client.
 * Registered per-client by the transport that owns the connection.
 */
export type PushCallback = (channel: string, ...args: any[]) => void;

interface RegisteredClient {
  client: TransportClient;
  push: PushCallback;
}

export class ClientRegistry {
  private clients = new Map<string, RegisteredClient>();

  /**
   * Register a client with its push callback.
   * The push callback is transport-specific: WS sends a MessageEnvelope frame,
   * SSE sends an event line.
   */
  register(client: TransportClient, push: PushCallback): void {
    this.clients.set(client.clientId, { client, push });
  }

  /**
   * Unregister a client (disconnected or stream closed).
   */
  unregister(clientId: string): void {
    this.clients.delete(clientId);
  }

  /**
   * Get a registered client by ID.
   */
  get(clientId: string): TransportClient | undefined {
    return this.clients.get(clientId)?.client;
  }

  /**
   * Push an event to clients matching a PushTarget.
   * This is the unified push that routes to both WS and SSE clients.
   */
  push(channel: string, target: PushTarget, ...args: any[]): void {
    for (const { client, push } of this.clients.values()) {
      if (this.matchesTarget(client, target)) {
        try {
          push(channel, ...args);
        } catch {
          // Don't let one client's error break push to others
        }
      }
    }
  }

  /**
   * Push to all clients subscribed to a specific session.
   * This is the primary push path for agent events.
   */
  pushToSession(sessionId: string, channel: string, ...args: any[]): void {
    for (const { client, push } of this.clients.values()) {
      if (client.subscribedSessions.has(sessionId)) {
        try {
          push(channel, ...args);
        } catch {
          // Don't let one client's error break push to others
        }
      }
    }
  }

  /**
   * Get all clients of a specific transport kind.
   */
  getByKind(kind: TransportKind): TransportClient[] {
    const result: TransportClient[] = [];
    for (const { client } of this.clients.values()) {
      if (client.kind === kind) {
        result.push(client);
      }
    }
    return result;
  }

  /**
   * Get all clients subscribed to a session.
   */
  getBySession(sessionId: string): TransportClient[] {
    const result: TransportClient[] = [];
    for (const { client } of this.clients.values()) {
      if (client.subscribedSessions.has(sessionId)) {
        result.push(client);
      }
    }
    return result;
  }

  /**
   * Total number of connected clients.
   */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Count clients by transport kind.
   */
  countByKind(kind: TransportKind): number {
    let count = 0;
    for (const { client } of this.clients.values()) {
      if (client.kind === kind) count++;
    }
    return count;
  }

  private matchesTarget(client: TransportClient, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.clientId !== target.exclude : true;
      case 'workspace':
        if (target.exclude && client.clientId === target.exclude) return false;
        return client.workspaceId === target.workspaceId;
      case 'client':
        return client.clientId === target.clientId;
      default:
        return false;
    }
  }
}
