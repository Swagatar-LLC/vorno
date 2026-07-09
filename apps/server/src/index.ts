import { PRODUCT_NAME } from '@craft-agent/shared/branding';
import { loadServerConfig, getConfigPath } from './config.ts';
import { CONFIG_DIR } from '@craft-agent/shared/config/paths';
import { createRouter } from './router.ts';
import { SessionPool } from './services/session-pool.ts';
import { EventBus } from './services/event-bus.ts';
import { ClientRegistry, WsTransport } from './transport/index.ts';
import { runProvisioningCli } from './provisioning.ts';

/**
 * Craft Agents Dual-Transport Server
 *
 * Exposes both REST+SSE and WebSocket transports on a single port.
 * - HTTP/SSE: REST API for external triggers (webhooks, scripts, CI/CD)
 * - WebSocket: upstream MessageEnvelope protocol for CLI and programmatic clients
 *
 * Both transports share the same SessionPool, EventBus, and ClientRegistry.
 */

// Headless provisioning CLI (PLAN-013): handle --generate-api-key /
// --provision-llm-key / --show-config and exit before touching the server.
const provisioning = await runProvisioningCli(process.argv);
if (provisioning.handled) {
  process.exit(provisioning.exitCode);
}

const config = loadServerConfig();

if (!config.enabled) {
  console.log(`${PRODUCT_NAME} server is disabled. Enable it in server-config.json or via the Electron UI.`);
  console.log(`Config path: ${getConfigPath()}`);
  console.log('Set "enabled": true to start the server.');
  process.exit(0);
}

// Initialize shared services
const eventBus = new EventBus();
const pool = new SessionPool(eventBus);
const registry = new ClientRegistry();
const wsTransport = new WsTransport(pool, eventBus, registry);
const router = createRouter(pool, registry);

// Idle session eviction (every 5 minutes, evict sessions idle for 30 minutes)
const EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;

const evictionTimer = setInterval(() => {
  const evicted = pool.evictIdle(MAX_IDLE_MS);
  if (evicted.length > 0) {
    console.log(`Evicted ${evicted.length} idle session(s): ${evicted.join(', ')}`);
  }
}, EVICTION_INTERVAL_MS);

// Start dual-transport server
const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 255, // Max value (seconds) — SSE streams and WS connections are long-lived

  // HTTP handler — also handles WebSocket upgrade
  fetch(request: Request, server) {
    // Try WebSocket upgrade first (for /ws and /rpc paths)
    if (wsTransport.tryUpgrade(request, server)) {
      return undefined as any; // Bun handles the upgrade
    }

    // Fall through to HTTP router
    return router(request);
  },

  // WebSocket handler — delegates to WsTransport
  websocket: wsTransport.websocketHandler(),
});

// Start WebSocket heartbeat
wsTransport.startHeartbeat();

console.log(`${PRODUCT_NAME} server running at http://${config.host}:${config.port}`);
console.log(`  Health:     http://${config.host}:${config.port}/health`);
console.log(`  REST API:   http://${config.host}:${config.port}/api/`);
console.log(`  WebSocket:  ws://${config.host}:${config.port}/ws`);

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  clearInterval(evictionTimer);
  wsTransport.shutdown();
  await pool.drainAll();
  server.stop();
  console.log('Server stopped.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
