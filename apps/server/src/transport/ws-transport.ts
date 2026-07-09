/**
 * WsTransport — Bun socket adapter over the runtime-neutral {@link WsProtocol}.
 *
 * Owns only the Bun-specific concerns: HTTP→WS upgrade via `server.upgrade()`
 * and the `Bun.serve({ websocket })` handler callbacks. All protocol logic
 * (handshake, heartbeat, RPC dispatch, push) lives in {@link WsProtocol}, shared
 * with the embedded Electron host's node `ws` adapter (PLAN-012 / ADR-0007).
 *
 * Bun's `ServerWebSocket<WsClientData>` structurally satisfies `WsSocketAdapter`
 * (it already carries `data` and exposes send/close/ping), so it is handed to the
 * protocol directly — the standalone Bun server stays byte-identical.
 */

import type { ServerWebSocket } from 'bun';
import { randomUUID } from 'node:crypto';

import { WsProtocol, type WsProtocolOptions } from './ws-protocol.ts';
import { createWsClientData } from './ws-socket.ts';
import type { SessionPool } from '../services/session-pool.ts';
import type { EventBus } from '../services/event-bus.ts';
import type { ClientRegistry } from './client-registry.ts';
import type { ServerConfig } from '../config.ts';
import type { WsClientData } from './types.ts';

export interface WsTransportOptions {
  pool: SessionPool;
  eventBus: EventBus;
  registry: ClientRegistry;
  /** Optional config loader override (defaults to loadServerConfig from disk). */
  getConfig?: () => ServerConfig;
}

export class WsTransport {
  private protocol: WsProtocol;

  /** Wrap an already-constructed protocol (composed core path — index.ts). */
  constructor(protocol: WsProtocol);
  constructor(opts: WsTransportOptions);
  /** @deprecated Use options object constructor */
  constructor(pool: SessionPool, eventBus: EventBus, registry: ClientRegistry);
  constructor(
    protocolOrPoolOrOpts: WsProtocol | SessionPool | WsTransportOptions,
    eventBus?: EventBus,
    registry?: ClientRegistry,
  ) {
    if (protocolOrPoolOrOpts instanceof WsProtocol) {
      this.protocol = protocolOrPoolOrOpts;
      return;
    }
    const opts: WsProtocolOptions = 'pool' in protocolOrPoolOrOpts
      ? protocolOrPoolOrOpts
      : { pool: protocolOrPoolOrOpts, eventBus: eventBus!, registry: registry! };
    this.protocol = new WsProtocol(opts);
  }

  /** The shared runtime-neutral protocol (exposed for the embedded host / tests). */
  get wsProtocol(): WsProtocol {
    return this.protocol;
  }

  // -------------------------------------------------------------------------
  // Bun.serve() websocket handler interface
  // -------------------------------------------------------------------------

  /**
   * Returns the websocket handler config for Bun.serve().
   * Wire this into Bun.serve({ websocket: transport.websocketHandler() }).
   */
  websocketHandler() {
    return {
      open: (ws: ServerWebSocket<WsClientData>) => this.protocol.handleOpen(ws),
      message: (ws: ServerWebSocket<WsClientData>, message: string | Buffer) =>
        this.protocol.handleMessage(ws, message),
      close: (ws: ServerWebSocket<WsClientData>, _code: number, _reason: string) =>
        this.protocol.handleClose(ws),
      // Bun calls drain when the send buffer empties; no-op for us
      drain: (_ws: ServerWebSocket<WsClientData>) => {},
    };
  }

  /**
   * Attempt to upgrade an HTTP request to WebSocket.
   * Returns true if the upgrade was initiated, false if it's not a WS request.
   */
  tryUpgrade(request: Request, server: ReturnType<typeof Bun.serve>): boolean {
    const url = new URL(request.url);

    // Only upgrade requests to /ws or /rpc
    if (url.pathname !== '/ws' && url.pathname !== '/rpc') {
      return false;
    }

    // Check for WebSocket upgrade header
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return false;
    }

    // Pre-create client data; actual auth happens during handshake
    const data: WsClientData = createWsClientData(randomUUID());

    const upgraded = server.upgrade(request, { data });
    return !!upgraded;
  }

  /** Start the heartbeat timer. Call once after server starts. */
  startHeartbeat(): void {
    this.protocol.startHeartbeat();
  }

  /** Stop heartbeat and close all WebSocket connections. */
  shutdown(): void {
    this.protocol.shutdown();
  }

  /** Number of connected WebSocket clients. */
  get clientCount(): number {
    return this.protocol.clientCount;
  }
}
