import { jsonResponse } from '../middleware/error.ts';
import type { SessionPool } from '../services/session-pool.ts';

const startTime = Date.now();

/**
 * GET /health — Server health check
 */
export function handleHealth(pool: SessionPool): Response {
  return jsonResponse({
    status: 'ok',
    version: '0.3.4',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeSessions: pool.activeCount,
  });
}
