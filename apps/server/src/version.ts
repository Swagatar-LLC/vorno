/**
 * Single source of truth for the trigger-server's advertised version.
 *
 * Surfaced by GET /health (fork fingerprint, PLAN-012) and the friendly
 * GET / landing page (VOR-48). Kept here so the two never drift.
 */
export const SERVER_VERSION = '0.4.0';
