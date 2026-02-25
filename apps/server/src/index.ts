import { loadServerConfig } from './config.ts';
import { createRouter } from './router.ts';
import { SessionPool } from './services/session-pool.ts';
import { EventBus } from './services/event-bus.ts';

/**
 * Craft Agents HTTP Trigger Server
 *
 * Exposes a REST + SSE API for external triggers (webhooks, scripts, CI/CD).
 * Shares the same ~/.craft-agent/ workspace filesystem as the Electron app.
 */

const config = loadServerConfig();

if (!config.enabled) {
  console.log('Craft Agents server is disabled. Enable it in server-config.json or via the Electron UI.');
  console.log(`Config path: ~/.craft-agent/server-config.json`);
  console.log('Set "enabled": true to start the server.');
  process.exit(0);
}

// Initialize services
const eventBus = new EventBus();
const pool = new SessionPool(eventBus);
const router = createRouter(pool);

// Idle session eviction (every 5 minutes, evict sessions idle for 30 minutes)
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;

const evictionTimer = setInterval(() => {
  const evicted = pool.evictIdle(MAX_IDLE_MS);
  if (evicted.length > 0) {
    console.log(`Evicted ${evicted.length} idle session(s): ${evicted.join(', ')}`);
  }
}, EVICTION_INTERVAL_MS);

// Start server
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: router,
});

console.log(`Craft Agents server running at http://${config.host}:${config.port}`);
console.log(`  Health: http://${config.host}:${config.port}/health`);
console.log(`  API:    http://${config.host}:${config.port}/api/`);

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  clearInterval(evictionTimer);
  await pool.drainAll();
  server.stop();
  console.log('Server stopped.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
