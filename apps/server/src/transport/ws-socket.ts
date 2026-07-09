/**
 * WsSocketAdapter — the runtime-neutral socket seam for the WS protocol.
 *
 * The protocol logic (handshake, heartbeat, RPC dispatch, push) operates only on
 * this interface, so the same code drives both runtimes:
 *  - Bun: `ServerWebSocket<WsClientData>` structurally satisfies this interface
 *    (it already has `data`, `send`, `close`, `ping`), so the standalone Bun
 *    path passes its sockets straight through — no wrapper, byte-identical.
 *  - Node (`ws`): the embedded Electron host wraps each `ws` WebSocket in a small
 *    adapter that carries a `data` object and forwards send/close/ping.
 */

import type { WsClientData } from './types.ts';

export interface WsSocketAdapter {
  /** Per-connection state (handshake status, auth, heartbeat bookkeeping). */
  readonly data: WsClientData;
  /** Send a serialized envelope string to the client. */
  send(data: string): void;
  /** Close the connection with a code + reason (WS close codes 4001–4005 etc.). */
  close(code: number, reason: string): void;
  /** Send a WebSocket ping frame (heartbeat). */
  ping(): void;
}

/**
 * Fresh per-connection client data. Auth fields are filled during the handshake.
 * Shared by both runtime adapters so the initial state can never drift.
 */
export function createWsClientData(clientId: string): WsClientData {
  return {
    clientId,
    apiKey: null as any, // Set during handshake
    workspaceId: null,
    capabilities: new Set(),
    handshakeCompleted: false,
    handshakeEnvelopeId: null,
    missedPongs: 0,
    alive: true,
  };
}
