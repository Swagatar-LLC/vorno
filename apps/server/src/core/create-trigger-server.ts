/**
 * createTriggerServer — the runtime-neutral trigger-server core (ADR-0007).
 *
 * Constructs the shared services (SessionPool, EventBus, ClientRegistry), the
 * fetch-style HTTP router, and the runtime-neutral WS protocol, then returns
 * them behind a small handle. Both hosts compose on this identical core:
 *
 *  - Standalone (Bun): `apps/server/src/index.ts` wraps `wsProtocol` with the Bun
 *    `WsTransport` socket adapter and serves `fetchHandler` via `Bun.serve`.
 *  - Embedded (Electron main): a `node:http` server serves `fetchHandler` and a
 *    node `ws` adapter drives `wsProtocol` (PLAN-012).
 *
 * The core takes a {@link HostBridge} so host-specific capabilities (the webhook
 * seam, later optional session routing) are injected, never assumed. Nothing
 * here may reference Electron, Bun, or node HTTP specifics.
 */

import { createRouter } from '../router.ts';
import { SessionPool } from '../services/session-pool.ts';
import { EventBus } from '../services/event-bus.ts';
import { ClientRegistry } from '../transport/client-registry.ts';
import { WsProtocol } from '../transport/ws-protocol.ts';
import type { ServerConfig } from '../config.ts';
import type { HostBridge } from './host-bridge.ts';

// Idle session eviction (every 5 minutes, evict sessions idle for 30 minutes)
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;

export interface TriggerServerCore {
  /** Fetch-style HTTP handler: (Request) => Promise<Response>. Runtime-neutral. */
  fetchHandler: (request: Request) => Promise<Response>;
  /** Runtime-neutral WS protocol; each host wraps it with a socket adapter. */
  wsProtocol: WsProtocol;
  /** Shared session pool (activeCount, drainAll, etc.). */
  pool: SessionPool;
  /** Unified client registry across WS + SSE. */
  registry: ClientRegistry;
  /** The host-adapter seam this core was constructed with. */
  hostBridge: HostBridge;
  /** Start the idle-session eviction timer. Returns a stop function. */
  startEviction: () => () => void;
  /** Drain sessions + stop the WS protocol. Does NOT own the listener. */
  shutdown: () => Promise<void>;
}

export interface CreateTriggerServerOptions {
  /** Optional config loader override (defaults to the WS protocol's own loader). */
  getConfig?: () => ServerConfig;
  /** Optional logger for eviction notices (defaults to console.log). */
  log?: (msg: string) => void;
}

/**
 * Construct the runtime-neutral trigger-server core.
 *
 * @param config    The loaded server config (host/port/apiKeys/rateLimits).
 * @param hostBridge The host-adapter seam (webhook + optional session routing).
 */
export function createTriggerServer(
  config: ServerConfig,
  hostBridge: HostBridge = {},
  options: CreateTriggerServerOptions = {},
): TriggerServerCore {
  const log = options.log ?? ((msg: string) => console.log(msg));

  const eventBus = new EventBus();
  const pool = new SessionPool(eventBus);
  const registry = new ClientRegistry();
  const wsProtocol = new WsProtocol({
    pool,
    eventBus,
    registry,
    getConfig: options.getConfig,
  });
  const router = createRouter(pool, registry);

  const fetchHandler = (request: Request): Promise<Response> => router(request);

  const startEviction = (): (() => void) => {
    const timer = setInterval(() => {
      const evicted = pool.evictIdle(MAX_IDLE_MS);
      if (evicted.length > 0) {
        log(`Evicted ${evicted.length} idle session(s): ${evicted.join(', ')}`);
      }
    }, EVICTION_INTERVAL_MS);
    return () => clearInterval(timer);
  };

  const shutdown = async (): Promise<void> => {
    wsProtocol.shutdown();
    await pool.drainAll();
  };

  // hostBridge is retained for the webhook receiver (VOR-33) and future session
  // routing; the core keeps its own SessionPool for REST/WS in v1 (parity).
  void config;

  return {
    fetchHandler,
    wsProtocol,
    pool,
    registry,
    hostBridge,
    startEviction,
    shutdown,
  };
}
