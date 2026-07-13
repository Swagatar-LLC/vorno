/**
 * Embedded host — runs the runtime-neutral trigger-server core in the Electron
 * main process on node:http + `ws` (PLAN-012 / ADR-0007).
 *
 * Two adapters bridge Node primitives to the core's runtime-neutral seams:
 *  - HTTP: a hand-rolled fetch bridge converts IncomingMessage → fetch Request,
 *    calls core.fetchHandler, and streams the Response back to ServerResponse
 *    (SSE-capable — chunks flush as they arrive, and a client disconnect cancels
 *    the reader).
 *  - WebSocket: a `WebSocketServer({ noServer: true })` handles /ws and /rpc
 *    upgrades; each socket is wrapped in a NodeWsSocket that satisfies the core's
 *    WsSocketAdapter and drives the shared WsProtocol.
 *
 * `ws` is already bundled into main.cjs (used by server-core's WsRpcServer), so
 * this adds zero packaging surface.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createWsClientData,
  type TriggerServerCore,
  type WsSocketAdapter,
  type WsClientData,
} from '@craft-agent/http-trigger/core';

// ---------------------------------------------------------------------------
// Node `ws` → WsSocketAdapter
// ---------------------------------------------------------------------------

class NodeWsSocket implements WsSocketAdapter {
  readonly data: WsClientData;
  constructor(private readonly ws: WebSocket, data: WsClientData) {
    this.data = data;
  }
  send(data: string): void {
    try { this.ws.send(data); } catch { /* connection may be closing */ }
  }
  close(code: number, reason: string): void {
    try { this.ws.close(code, reason); } catch { /* already closed */ }
  }
  ping(): void {
    try { this.ws.ping(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch bridge
// ---------------------------------------------------------------------------

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function bridgeToFetch(
  core: TriggerServerCore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? '127.0.0.1';
  const url = `http://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readRequestBody(req);
  }

  let response: Response;
  try {
    // Body is fully buffered (not a stream), so no `duplex` is needed. Copy into a
    // plain Uint8Array — a valid BufferSource BodyInit that TS accepts.
    const request = new Request(url, {
      method,
      headers,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
    });
    response = await core.fetchHandler(request);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Node manages transfer-encoding/content-length itself for streamed bodies.
    if (key.toLowerCase() === 'content-length' && !response.headers.get('content-length')) return;
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  // Stream the body so SSE frames flush immediately.
  const reader = response.body.getReader();
  let cancelled = false;
  res.on('close', () => {
    cancelled = true;
    reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || cancelled) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    // Stream errored or client vanished — fall through to end().
  } finally {
    if (!cancelled) res.end();
  }
}

// ---------------------------------------------------------------------------
// Embedded host
// ---------------------------------------------------------------------------

export interface EmbeddedHostOptions {
  /** Fatal host-level errors AFTER a successful listen (transitions supervisor to error). */
  onError?: (err: Error) => void;
}

export interface EmbeddedHost {
  /**
   * Bind the listener. Rejects on EADDRINUSE / bind failure (surfaced
   * synchronously). Resolves with the ACTUAL bound port — this matters when the
   * caller requested port 0 (OS-assigned ephemeral port); the resolved value is
   * the port the health check and status must use, NOT the requested 0.
   */
  listen(host: string, port: number): Promise<number>;
  /** Stop accepting, close WS clients, and close the listener. */
  close(): Promise<void>;
}

/**
 * Wire the runtime-neutral core to a node:http + `ws` listener. Does not start
 * listening — the supervisor calls `listen()`.
 */
export function createEmbeddedHost(
  core: TriggerServerCore,
  options: EmbeddedHostOptions = {},
): EmbeddedHost {
  const httpServer: Server = createServer((req, res) => {
    void bridgeToFetch(core, req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch { /* keep default */ }

    if (pathname !== '/ws' && pathname !== '/rpc') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sock = new NodeWsSocket(ws, createWsClientData(randomUUID()));
      core.wsProtocol.handleOpen(sock);
      ws.on('message', (data: Buffer) => {
        void core.wsProtocol.handleMessage(sock, data);
      });
      ws.on('close', () => core.wsProtocol.handleClose(sock));
      ws.on('error', () => core.wsProtocol.handleClose(sock));
    });
  });

  return {
    listen(host: string, port: number): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          // Post-listen errors are fatal host faults, not bind failures.
          httpServer.on('error', (err) => options.onError?.(err));
          // Read back the OS-assigned port (mirrors WsRpcServer in
          // packages/server-core/src/transport/server.ts). When port 0 was
          // requested, address() carries the real ephemeral port; fall back to
          // the requested port if address() isn't an AddressInfo object.
          const addr = httpServer.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : port;
          resolve(boundPort);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },

    async close(): Promise<void> {
      // WS clients are asked to close gracefully by the core (WsProtocol.shutdown
      // sends 1001) before this runs; terminate() here is an idempotent backstop.
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      // Force-drop lingering HTTP/SSE sockets so httpServer.close() can't hang on
      // a long-lived event stream. closeAllConnections lands in Node 18.2+.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
