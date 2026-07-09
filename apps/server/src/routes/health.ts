import { jsonResponse } from '../middleware/error.ts';
import { SERVER_VERSION } from '../version.ts';
import type { SessionPool } from '../services/session-pool.ts';
import type { ClientRegistry } from '../transport/client-registry.ts';

const startTime = Date.now();

/**
 * GET /health — Server health check
 */
export function handleHealth(pool: SessionPool, registry?: ClientRegistry): Response {
  return jsonResponse({
    status: 'ok',
    // Fork fingerprint (PLAN-012): lets the embedded-host supervisor disambiguate
    // "another trigger-server instance holds this port" from "some unrelated app".
    // Static, non-branded, leaks no version beyond `version` below.
    fork: 'trigger-server',
    version: SERVER_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeSessions: pool.activeCount,
    transports: {
      http: 'active',
      websocket: 'active',
      wsClients: registry?.countByKind('websocket') ?? 0,
      sseClients: registry?.countByKind('sse') ?? 0,
    },
  });
}
