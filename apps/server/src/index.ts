import { PRODUCT_NAME } from '@craft-agent/shared/branding';
import { loadServerConfig, getConfigPath } from './config.ts';
import { createTriggerServer } from './core/create-trigger-server.ts';
import { WsTransport } from './transport/index.ts';
import { runProvisioningCli } from './provisioning.ts';
import { createStandaloneHost, isStandaloneEnabled, type StandaloneHost } from './standalone/host.ts';
import { version as packageVersion } from '../package.json';

/**
 * Craft Agents Dual-Transport Server — standalone Bun host.
 *
 * Exposes both REST+SSE and WebSocket transports on a single port.
 * - HTTP/SSE: REST API for external triggers (webhooks, scripts, CI/CD)
 * - WebSocket: upstream MessageEnvelope protocol for CLI and programmatic clients
 *
 * This entry composes the runtime-neutral core (createTriggerServer, PLAN-012)
 * with Bun's socket adapter (WsTransport). The embedded Electron host composes
 * the same core with a node:http + `ws` adapter. Behavior here is unchanged from
 * the pre-refactor server. Standalone mode (PLAN-013) layers an in-process
 * headless SessionManager + AutomationSystem alongside the trigger surface.
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

// Construct the runtime-neutral core (PLAN-012). The standalone Bun entry injects
// an empty HostBridge — the trigger-surface webhook seam is bound by the embedded
// host; standalone mode's own headless webhook seam lives at the host layer below.
const core = createTriggerServer(config, {});

// Bun socket adapter wrapping the core's shared WS protocol (one protocol /
// registry / pool instance across both transports).
const wsTransport = new WsTransport(core.wsProtocol);

// Idle session eviction (every 5 minutes, evict sessions idle for 30 minutes).
const stopEviction = core.startEviction();

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
    return core.fetchHandler(request);
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

// Standalone mode (PLAN-013): compose an in-process headless SessionManager +
// AutomationSystem alongside the trigger surface. Opt-in via CRAFT_STANDALONE.
// A failure here must not silently degrade the trigger server — log and exit so
// the operator sees it (e.g. a held .server.lock from a concurrent host).
let standaloneHost: StandaloneHost | null = null;
if (isStandaloneEnabled()) {
  try {
    standaloneHost = await createStandaloneHost({ appVersion: packageVersion });
    console.log('Standalone mode: headless SessionManager + AutomationSystem active.');
  } catch (err) {
    console.error(`Failed to start standalone host: ${err instanceof Error ? err.message : String(err)}`);
    stopEviction();
    wsTransport.shutdown();
    server.stop();
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  stopEviction();
  await core.shutdown();
  if (standaloneHost) {
    await standaloneHost.dispose();
  }
  server.stop();
  console.log('Server stopped.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
