/**
 * fork(PLAN-020): WebUI embedded host.
 * fork(PLAN-022): single-port WS proxy — the browser's WS-RPC upgrade now goes
 * THROUGH this listener (path `/ws`) so remote access exposes exactly one port.
 *
 * A `node:http` listener that serves the desktop WebUI fetch handler via the
 * portable upstream `nodeHttpAdapter`. Originally (PLAN-020) this had NO
 * WebSocket-upgrade handling — the browser connected DIRECTLY to the in-process
 * `WsRpcServer` on its own ephemeral port. That only worked same-host: the RPC
 * server binds 127.0.0.1 only, so remote clients couldn't reach it and every
 * RPC call failed (LEARNING-028). PLAN-022 adds an `upgrade` handler (the
 * trigger-server `host.ts` idiom) that authenticates the `craft_session` cookie
 * and RAW-TCP splices the upgrade through to the loopback RPC listener. The
 * forwarded Cookie header re-authenticates at the RPC hop, so auth holds twice.
 * The proxy is path-scoped to `/ws`; other upgrade paths are refused.
 *
 * `listen()` rejects synchronously on EADDRINUSE / bind failure (the supervisor
 * distinguishes port conflicts); post-listen faults surface through `onError`.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { nodeHttpAdapter } from '@craft-agent/server-core/webui';

/** A fetch handler this host can serve (mirrors WebUiHandler.fetch). */
type FetchHandler = (req: Request) => Promise<Response> | Response;

/** Loopback RPC target the `/ws` upgrade is spliced to. */
export type WsProxyTarget = { port: number } | undefined;

export interface WebUiHostOptions {
  /** Fatal host-level errors AFTER a successful listen (transitions supervisor to error). */
  onError?: (err: Error) => void;
  /**
   * fork(PLAN-022): validate a `craft_session` cookie header on the WS upgrade.
   * When present (with `getWsTarget`), the host proxies authenticated `/ws`
   * upgrades to the loopback RPC listener. Omit both to disable the proxy.
   */
  validateCookie?: (cookieHeader: string | null) => Promise<boolean>;
  /** fork(PLAN-022): the live loopback RPC endpoint to splice `/ws` upgrades to. */
  getWsTarget?: () => WsProxyTarget;
}

export interface WebUiHost {
  /**
   * Bind the listener and resolve with the actually-bound port (matches the
   * trigger-server `EmbeddedHost.listen()` signature, PLAN-018). Rejects on
   * EADDRINUSE / bind failure (surfaced synchronously).
   */
  listen(host: string, port: number): Promise<number>;
  /** Close the listener. */
  close(): Promise<void>;
}

/**
 * Wire a WebUI fetch handler to a node:http listener. Does not start listening —
 * the supervisor calls `listen()`.
 */
/**
 * fork(PLAN-022): parse the `pathname` off a raw upgrade request URL. The Host
 * header is untrusted, so a fixed base is used purely to make `URL` parse — only
 * the pathname is read back.
 */
function upgradePathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * fork(PLAN-022): reject a WS upgrade with a raw HTTP status line, then destroy
 * the socket. Used before any `net.connect` — the browser client surfaces this
 * as a failed connection (which the connection-error screen catches).
 */
function rejectUpgrade(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  } catch {
    /* socket may already be gone */
  }
  socket.destroy();
}

export function createWebUiHost(
  handler: FetchHandler,
  options: WebUiHostOptions = {},
): WebUiHost {
  const httpServer: Server = createServer(nodeHttpAdapter(handler));

  // fork(PLAN-022): single-port WS proxy. Only wired when both seams are present
  // (same-host builds can omit them; the browser then connects to the RPC port
  // directly as before). Path-scoped to `/ws`; auth via the login cookie.
  if (options.validateCookie && options.getWsTarget) {
    const validateCookie = options.validateCookie;
    const getWsTarget = options.getWsTarget;

    httpServer.on('upgrade', (req, socket, head) => {
      void handleWsUpgrade(req, socket, head, validateCookie, getWsTarget);
    });
  }

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
      // Force-drop lingering sockets so close() can't hang. (Node 18.2+.)
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/**
 * fork(PLAN-022): handle a WS upgrade on the WebUI port.
 *
 * 1. Only `/ws` is proxied — any other upgrade path is refused (destroy).
 * 2. The `craft_session` cookie is validated (login-cookie auth). A missing /
 *    invalid cookie ⇒ `401` and destroy.
 * 3. No live RPC target ⇒ `503` and destroy.
 * 4. On success, open a raw TCP connection to 127.0.0.1:<port>, replay the
 *    original request line + headers + any buffered `head` bytes, and splice
 *    both sockets bidirectionally. The RPC `WsRpcServer` performs the actual
 *    WebSocket handshake and re-validates the forwarded Cookie header, so auth
 *    holds at both hops. This is a raw byte splice — deliberately NOT a
 *    ws-client/ws-server re-frame (the RPC protocol is unchanged; wire-compat
 *    contract untouched).
 */
export async function handleWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  validateCookie: (cookieHeader: string | null) => Promise<boolean>,
  getWsTarget: () => WsProxyTarget,
): Promise<void> {
  if (upgradePathname(req) !== '/ws') {
    socket.destroy();
    return;
  }

  let authorized = false;
  try {
    authorized = await validateCookie(req.headers.cookie ?? null);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    rejectUpgrade(socket, '401 Unauthorized');
    return;
  }

  const target = getWsTarget();
  if (!target) {
    rejectUpgrade(socket, '503 Service Unavailable');
    return;
  }

  // The client socket may error/close while we set up the upstream leg.
  if (socket.destroyed) return;

  const upstream: Socket = netConnect({ host: '127.0.0.1', port: target.port });

  const teardown = () => {
    upstream.destroy();
    socket.destroy();
  };

  upstream.on('error', teardown);
  socket.on('error', teardown);

  upstream.on('connect', () => {
    // Replay the upgrade request verbatim so the RPC server sees the original
    // request line, Host, Upgrade/Connection, Sec-WebSocket-* and Cookie headers.
    const requestLine = `${req.method ?? 'GET'} ${req.url ?? '/ws'} HTTP/${req.httpVersion ?? '1.1'}\r\n`;
    const headerLines: string[] = [];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      headerLines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    upstream.write(requestLine + headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);

    // Bidirectional byte splice. `pipe` forwards data + end; the error/close
    // handlers above tear down the peer on either side dying.
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on('close', teardown);
    upstream.on('close', teardown);
  });
}
