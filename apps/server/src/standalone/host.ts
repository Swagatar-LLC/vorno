/**
 * Standalone-mode host composition for the trigger server (PLAN-013, VOR-35/43).
 *
 * The fork's `apps/server` normally runs as a pure external trigger surface
 * (REST+SSE+WS over `SessionPool`/`AgentSession`). Standalone mode adds, in the
 * SAME process and alongside that trigger path, an in-process headless
 * `server-core` `SessionManager` — which owns the per-workspace
 * `AutomationSystem` (scheduler + handlers) — so automations and (via PLAN-014)
 * inbound webhooks run with no Electron host present.
 *
 * This composes the proven headless subsystem wiring that `packages/server`'s
 * `bootstrapServer` uses, but WITHOUT its WS RPC server: we only want the
 * SessionManager + AutomationSystem, not a second app-server on another port.
 *
 * Design decisions recorded in ADR-0008 and PLAN-013 (open questions):
 *
 *  - **`.server.lock`**: standalone mode ACQUIRES `{CONFIG_DIR}/.server.lock`
 *    (reusing server-core's `acquireServerLock`). Once this process owns an
 *    in-process SessionManager writing workspace/session state under CONFIG_DIR,
 *    a concurrently launched `packages/server` (which also takes the lock) would
 *    be a second writer to the same state. Taking the lock makes the two hosts
 *    mutually exclusive on a shared config dir — the correct safety posture. The
 *    pure trigger path (standalone OFF) keeps taking no lock, preserving today's
 *    behavior exactly.
 *
 *  - **Two session stacks**: the trigger `SessionPool` and the standalone
 *    `SessionManager` run side by side (parallel, not converged). Convergence is
 *    a larger refactor out of scope for this PoC; documented as future work.
 *
 *  - **`onWebhookEvent` seam**: instantiated at THIS host layer (per ADR-0007's
 *    HostBridge model), not threaded into the upstream-synced AutomationSystem /
 *    SessionManager. PLAN-014 owns the payload semantics and the dispatch into
 *    the workspace AutomationSystem; here we hold the callback and default it to
 *    a logging stub so the seam is demonstrably instantiable with no Electron
 *    host. The SessionManager (and its AutomationSystems) is exposed so PLAN-014
 *    can route ingested events into automation matchers.
 */

import { CONFIG_DIR, CONFIG_DIR_RESOLUTION } from '@craft-agent/shared/config/paths';
import { ensureConfigDir, loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { createHeadlessPlatform } from '@craft-agent/server-core/runtime';
import {
  SessionManager,
  setSessionPlatform,
  setSessionRuntimeHooks,
} from '@craft-agent/server-core/sessions';
import { initModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers';
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services';
import { acquireServerLock, releaseServerLock } from '@craft-agent/server-core/bootstrap';
import type { EventSink } from '@craft-agent/server-core/transport';

/**
 * Inbound webhook event handed to the standalone host by a future receiver
 * (PLAN-014). This is a minimal forward-declared shape kept at the host layer;
 * PLAN-014 refines the payload vocabulary and everything downstream. Defined in
 * apps/server (not packages/shared) so PLAN-014's automations work does not
 * collide with a shared-type edit here.
 */
export interface WebhookInboundEvent {
  /** Target workspace whose AutomationSystem should evaluate the event. */
  workspaceId: string;
  /** Opaque route/source identifier (PLAN-014 defines the vocabulary). */
  source?: string;
  /** Raw payload as received. Shape refined by PLAN-014. */
  payload?: unknown;
  /** Epoch ms the event was received by the host. */
  receivedAt: number;
}

export type OnWebhookEvent = (event: WebhookInboundEvent) => void | Promise<void>;

export interface StandaloneHostOptions {
  /** App version string for the headless platform handshake. */
  appVersion?: string;
  /**
   * The webhook seam. PLAN-014 injects the real dispatch; when omitted, a
   * logging stub is installed so the seam is instantiated (never silently
   * dropped) even before PLAN-014 lands.
   */
  onWebhookEvent?: OnWebhookEvent;
}

export interface StandaloneHost {
  /** The in-process headless SessionManager (owns per-workspace AutomationSystems). */
  readonly sessionManager: SessionManager;
  /** The instantiated webhook seam (stub or PLAN-014-provided). */
  readonly onWebhookEvent: OnWebhookEvent;
  /** Flush + tear down the SessionManager and release the server lock. */
  dispose(): Promise<void>;
}

/**
 * Is standalone mode requested? Off by default — a bare `apps/server` stays a
 * pure trigger surface. Enable with `CRAFT_STANDALONE=1` (or true/yes/on).
 */
export function isStandaloneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CRAFT_STANDALONE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Compose and start the standalone headless host. Acquires `.server.lock`,
 * builds the headless platform, wires the platform into the session subsystems,
 * constructs and initializes the SessionManager (which brings up each
 * workspace's AutomationSystem), and instantiates the `onWebhookEvent` seam.
 *
 * Throws if `.server.lock` is held by a live instance (a concurrent
 * `packages/server` or another standalone host on the same CONFIG_DIR).
 */
export async function createStandaloneHost(options: StandaloneHostOptions = {}): Promise<StandaloneHost> {
  const platform = createHeadlessPlatform({ appVersion: options.appVersion });

  // Wire the headless platform into the session/tool subsystems — the same set
  // packages/server's bootstrapServer applies, minus the WS transport.
  setFetcherPlatform(platform);
  setSessionPlatform(platform);
  setSessionRuntimeHooks({
    updateBadgeCount: () => {},
    captureException: (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      platform.captureError?.(err);
    },
  });
  setSearchPlatform(platform);
  setImageProcessor(platform.imageProcessor);

  // Config-dir resolution logging (ADR-0005) — which dir is active and why.
  platform.logger.info(`[config-dir] Using ${CONFIG_DIR_RESOLUTION.dir} — ${CONFIG_DIR_RESOLUTION.reason}`);
  if (CONFIG_DIR_RESOLUTION.migration && CONFIG_DIR_RESOLUTION.migration.action !== 'already-done') {
    platform.logger.info(`[config-dir] Migration outcome: ${JSON.stringify(CONFIG_DIR_RESOLUTION.migration)}`);
  }

  // Ensure the config dir + a global config exist (fresh volume / first boot).
  ensureConfigDir();
  if (!loadStoredConfig()) {
    saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null });
    platform.logger.info('[standalone] Initialized missing global config');
  }

  // Open question 2 decision: standalone acquires the exclusive server lock.
  acquireServerLock(platform.logger);

  const modelRefresh = initModelRefreshService(async (slug: string) => {
    const manager = getCredentialManager();
    const [apiKey, oauth] = await Promise.all([
      manager.getLlmApiKey(slug).catch(() => null),
      manager.getLlmOAuth(slug).catch(() => null),
    ]);
    return {
      apiKey: apiKey ?? undefined,
      oauthAccessToken: oauth?.accessToken,
      oauthRefreshToken: oauth?.refreshToken,
      oauthIdToken: oauth?.idToken,
    };
  });

  // Instantiate the webhook seam (stub until PLAN-014 injects real dispatch).
  const onWebhookEvent: OnWebhookEvent =
    options.onWebhookEvent ??
    ((event) => {
      platform.logger.info(
        `[standalone] onWebhookEvent seam invoked (workspace=${event.workspaceId}, source=${event.source ?? 'n/a'}) ` +
        `— no dispatcher wired yet (PLAN-014).`
      );
    });

  const sessionManager = new SessionManager();
  // No RPC clients in standalone mode — session events have no remote sink.
  // Automations create and run sessions internally regardless of the sink.
  const noopSink: EventSink = () => {};
  sessionManager.setEventSink(noopSink);

  await sessionManager.initialize();
  modelRefresh.startAll();

  platform.logger.info('[standalone] Headless SessionManager + AutomationSystem initialized');

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      modelRefresh.stopAll?.();
    } catch (err) {
      platform.logger.error('[standalone] model refresh stop failed:', err);
    }
    try {
      await sessionManager.flushAllSessions();
    } catch (err) {
      platform.logger.error('[standalone] flushAllSessions failed:', err);
    } finally {
      try {
        sessionManager.cleanup();
      } catch (err) {
        platform.logger.error('[standalone] SessionManager cleanup failed:', err);
      }
    }
    releaseServerLock();
    platform.logger.info('[standalone] Host disposed, server lock released');
  };

  return { sessionManager, onWebhookEvent, dispose };
}
