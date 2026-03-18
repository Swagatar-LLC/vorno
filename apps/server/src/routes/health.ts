import { jsonResponse } from '../middleware/error.ts';
import type { SessionPool } from '../services/session-pool.ts';
import type { ClientRegistry } from '../transport/client-registry.ts';

const startTime = Date.now();

/**
 * GET /health — Server health check
 */
export function handleHealth(pool: SessionPool, registry?: ClientRegistry): Response {
  return jsonResponse({
    status: 'ok',
    version: '0.4.0',
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
