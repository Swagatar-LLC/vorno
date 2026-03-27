/**
 * Transport abstraction types for the dual-transport server.
 *
 * Defines a common interface for WebSocket and HTTP/SSE clients so that
 * event push routing, client tracking, and auth can be shared.
 */

import type { StoredApiKey } from '../config.ts';

// ---------------------------------------------------------------------------
// Transport kind
// ---------------------------------------------------------------------------

export type TransportKind = 'websocket' | 'sse';

// ---------------------------------------------------------------------------
// Client connection
// ---------------------------------------------------------------------------

/**
 * A connected client, regardless of transport.
 * WebSocket clients are persistent; SSE clients register per-stream.
 */
export interface TransportClient {
  /** Unique client ID (UUID) */
  clientId: string;
  /** Which transport this client is using */
  kind: TransportKind;
  /** Authenticated API key */
  apiKey: StoredApiKey;
  /** Workspace this client is scoped to (from handshake or session create) */
  workspaceId: string | null;
  /** Client-advertised capabilities (WebSocket only, empty for SSE) */
  capabilities: Set<string>;
  /** When this client connected */
  connectedAt: number;
  /** Session IDs this client is subscribed to */
  subscribedSessions: Set<string>;
}

// ---------------------------------------------------------------------------
// WebSocket client data (attached to Bun ServerWebSocket)
// ---------------------------------------------------------------------------

/**
 * Per-connection data attached to Bun's ServerWebSocket via the generic.
 * This is the `ws.data` field set during server.upgrade().
 */
export interface WsClientData {
  clientId: string;
  apiKey: StoredApiKey;
  workspaceId: string | null;
  capabilities: Set<string>;
  handshakeCompleted: boolean;
  handshakeEnvelopeId: string | null;
  missedPongs: number;
  alive: boolean;
}
