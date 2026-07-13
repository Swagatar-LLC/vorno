/**
 * fork(PLAN-020): WebUI embedded host.
 *
 * A `node:http` listener that serves the desktop WebUI fetch handler via the
 * portable upstream `nodeHttpAdapter`. This is the trigger-server `host.ts`
 * pattern MINUS all WebSocket-upgrade handling: the browser's WS-RPC connection
 * goes DIRECTLY to the in-process `WsRpcServer` (on its own ephemeral port),
 * NOT through this listener (Q1/Q2). This host only serves login/static/JSON.
 *
 * `listen()` rejects synchronously on EADDRINUSE / bind failure (the supervisor
 * distinguishes port conflicts); post-listen faults surface through `onError`.
 */

import { createServer, type Server } from 'node:http';
import { nodeHttpAdapter } from '@craft-agent/server-core/webui';

/** A fetch handler this host can serve (mirrors WebUiHandler.fetch). */
type FetchHandler = (req: Request) => Promise<Response> | Response;

export interface WebUiHostOptions {
  /** Fatal host-level errors AFTER a successful listen (transitions supervisor to error). */
  onError?: (err: Error) => void;
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
export function createWebUiHost(
  handler: FetchHandler,
  options: WebUiHostOptions = {},
): WebUiHost {
  const httpServer: Server = createServer(nodeHttpAdapter(handler));

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
