/**
 * TriggerServerSupervisor — single source of runtime truth for the embedded
 * HTTP trigger server (PLAN-012 / ADR-0007).
 *
 * Owns the state machine (stopped → starting → running/error → stopping →
 * stopped), the in-process node:http + ws host, config persistence, and API-key
 * lifecycle. The tray reads this directly; the settings page drives it through
 * craft-fork:triggerServer:* IPC. Both go through this one object, so their views
 * are always coherent.
 *
 * server-config.json is the sole config store. `enabled` is the DESIRED state:
 * start/stop persist it, so a relaunch restores the user's last choice
 * (autostart via reconcile()).
 */

import {
  createTriggerServer,
  loadServerConfig,
  saveServerConfig,
  generateApiKey,
  addApiKey,
  revokeApiKey as revokeStoredApiKey,
  type ServerConfig,
  type ApiKeyPermissions,
  type TriggerServerCore,
  type HostBridge,
} from '@craft-agent/http-trigger/core';
import type { WebhooksHandle } from '@craft-agent/shared/automations'; // fork(PLAN-014)
import { createEmbeddedHost, type EmbeddedHost, type EmbeddedHostOptions } from './host';
import type {
  RemoteAccessConfig,
  RemoteAccessStatus,
  RemoteAccessState,
  RemoteAccessStartResult,
  RemoteAccessCreatedKey,
  RemoteAccessApiKeyInfo,
} from '../../shared/types';

const HEALTH_TIMEOUT_MS = 3_000;
const DRAIN_CAP_MS = 10_000;
const AUTO_RESTART_DELAY_MS = 2_000;

export interface SupervisorLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

const NOOP_LOGGER: SupervisorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Health-probe result shape (the two fields the supervisor inspects). */
export interface HealthProbeResult {
  status?: string;
  fork?: string;
}

export interface SupervisorOptions {
  /** The host-adapter seam (onWebhookEvent bound to the desktop automation system). */
  hostBridge?: HostBridge;
  /**
   * fork(PLAN-014): the inbound-webhook receiver handle. When present, it is
   * threaded into every `createTriggerServer` construction so the embedded
   * trigger server serves the pre-auth `POST /hooks/...` route (LEARNING-018).
   * Owned by the caller (built once at bootstrap, disposed on app teardown); the
   * supervisor only forwards it and never disposes it across start/stop cycles.
   */
  webhooks?: WebhooksHandle;
  log?: SupervisorLogger;
  /** Called on every state transition so the tray/UI can re-render. */
  onStateChange?: (status: RemoteAccessStatus) => void;
  /** Test seam: build the embedded host (defaults to createEmbeddedHost). */
  hostFactory?: (core: TriggerServerCore, opts: EmbeddedHostOptions) => EmbeddedHost;
  /** Test seam: probe /health (defaults to a real fetch). */
  healthProbe?: (host: string, port: number) => Promise<HealthProbeResult | null>;
}

export class TriggerServerSupervisor {
  private state: RemoteAccessState = 'stopped';
  private core: TriggerServerCore | null = null;
  private host: EmbeddedHost | null = null;
  private stopEviction: (() => void) | null = null;
  private startedAt: number | undefined;
  private lastError: string | undefined;
  private configStale = false;
  private restartAttempted = false;
  private boundHost: string | undefined;
  /** ACTUAL bound port (OS-assigned when config.port is 0) — runtime status. */
  private boundPort: number | undefined;
  /**
   * The CONFIGURED port that was requested at start (desired state, may be 0).
   * Used only for the configStale comparison so an OS-assigned ephemeral port
   * never reads as a config change against itself.
   */
  private boundRequestedPort: number | undefined;

  private readonly hostBridge: HostBridge;
  private readonly webhooks: WebhooksHandle | undefined;
  private readonly log: SupervisorLogger;
  private readonly onStateChange: ((status: RemoteAccessStatus) => void) | undefined;
  private readonly hostFactory: (core: TriggerServerCore, opts: EmbeddedHostOptions) => EmbeddedHost;
  private readonly healthProbe: (host: string, port: number) => Promise<HealthProbeResult | null>;

  constructor(opts: SupervisorOptions = {}) {
    this.hostBridge = opts.hostBridge ?? {};
    this.webhooks = opts.webhooks;
    this.log = opts.log ?? NOOP_LOGGER;
    this.onStateChange = opts.onStateChange;
    this.hostFactory = opts.hostFactory ?? createEmbeddedHost;
    this.healthProbe = opts.healthProbe ?? ((host, port) => this.fetchHealth(host, port));
  }

  // -------------------------------------------------------------------------
  // Public status / config
  // -------------------------------------------------------------------------

  getStatus(): RemoteAccessStatus {
    return {
      running: this.state === 'running',
      state: this.state,
      host: this.boundHost,
      port: this.boundPort,
      startedAt: this.startedAt,
      activeSessions: this.core?.pool.activeCount ?? 0,
      configStale: this.configStale || undefined,
      lastError: this.lastError,
    };
  }

  /** Sanitized config for the renderer — API-key metadata only, never hashes. */
  getConfig(): RemoteAccessConfig {
    return toRemoteAccessConfig(loadServerConfig());
  }

  /**
   * Persist config changes. host/port/rate-limit changes apply on restart
   * (configStale surfaces "restart to apply"); API-key changes apply live
   * because the auth middleware re-reads config per request.
   */
  updateConfig(updates: Partial<RemoteAccessConfig>): RemoteAccessConfig {
    const current = loadServerConfig();
    const next: ServerConfig = { ...current };

    if (typeof updates.enabled === 'boolean') next.enabled = updates.enabled;
    if (typeof updates.host === 'string') next.host = updates.host;
    if (typeof updates.port === 'number') next.port = updates.port;
    if (updates.rateLimits) {
      next.rateLimits = {
        requestsPerMinute: updates.rateLimits.requestsPerMinute ?? current.rateLimits.requestsPerMinute,
        concurrentSessions: updates.rateLimits.concurrentSessions ?? current.rateLimits.concurrentSessions,
      };
    }
    // apiKeys are never written through updateConfig — use createApiKey/revokeApiKey.

    saveServerConfig(next);

    if (this.state === 'running') {
      const runtimeChanged =
        next.host !== this.boundHost ||
        next.port !== this.boundRequestedPort ||
        next.rateLimits.requestsPerMinute !== current.rateLimits.requestsPerMinute ||
        next.rateLimits.concurrentSessions !== current.rateLimits.concurrentSessions;
      if (runtimeChanged) {
        this.configStale = true;
        this.emit();
      }
    }

    return toRemoteAccessConfig(next);
  }

  createApiKey(name: string, permissions: ApiKeyPermissions): RemoteAccessCreatedKey {
    const config = loadServerConfig();
    const { fullKey, stored } = generateApiKey(name, permissions);
    addApiKey(config, stored);
    return { fullKey, info: toKeyInfo(stored) };
  }

  revokeApiKey(keyId: string): boolean {
    const config = loadServerConfig();
    return revokeStoredApiKey(config, keyId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Autostart reconciliation at app launch: start iff enabled is the desired
   * state. Safe to call once during startup.
   */
  async reconcile(): Promise<void> {
    const config = loadServerConfig();
    if (config.enabled && this.state === 'stopped') {
      this.log.info('[trigger-server] autostart (enabled=true)');
      await this.startInternal();
    }
  }

  /** User/UI start: persist desired-state and start. */
  async start(): Promise<RemoteAccessStartResult> {
    const config = loadServerConfig();
    if (!config.enabled) {
      saveServerConfig({ ...config, enabled: true });
    }
    return this.startInternal();
  }

  /** User/UI stop: persist desired-state and tear down. */
  async stop(): Promise<void> {
    const config = loadServerConfig();
    if (config.enabled) {
      saveServerConfig({ ...config, enabled: false });
    }
    await this.teardown();
  }

  /** app before-quit hook: tear down without touching desired-state. */
  async dispose(): Promise<void> {
    if (this.state === 'stopped') return;
    await this.teardown();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async startInternal(): Promise<RemoteAccessStartResult> {
    if (this.state === 'running' || this.state === 'starting') {
      return { success: true };
    }

    this.setState('starting');
    const config = loadServerConfig();

    let core: TriggerServerCore;
    let host: EmbeddedHost;
    let actualPort: number;
    try {
      core = createTriggerServer(config, this.hostBridge, {
        log: (msg) => this.log.info(`[trigger-server] ${msg}`),
        webhooks: this.webhooks, // fork(PLAN-014): serve the pre-auth /hooks route
      });
      host = this.hostFactory(core, {
        onError: (err) => this.onHostError(err),
      });
      // listen() resolves with the ACTUAL bound port. With config.port === 0 the
      // OS assigns an ephemeral port; health-checking config.port (0) would fail
      // (LEARNING-021). Everything downstream uses actualPort instead.
      actualPort = await host.listen(config.host, config.port);
    } catch (err) {
      return this.failStart(err, config);
    }

    // Self health check on the bound listener (127.0.0.1 when bound to 0.0.0.0).
    const healthHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    const healthy = await this.selfHealthCheck(healthHost, actualPort);
    if (!healthy) {
      try { await host.close(); } catch { /* ignore */ }
      try { await core.shutdown(); } catch { /* ignore */ }
      this.lastError = 'Server started but failed its health check';
      this.setState('error');
      return { success: false, error: this.lastError };
    }

    this.core = core;
    this.host = host;
    this.stopEviction = core.startEviction();
    core.wsProtocol.startHeartbeat();
    this.startedAt = Date.now();
    this.boundHost = config.host;
    // Runtime status = actual bound port (ephemeral when config.port was 0).
    this.boundPort = actualPort;
    // Desired-state port for the stale comparison (may be 0 — never overwritten
    // with the ephemeral value, so port-0 doesn't read as perpetually stale).
    this.boundRequestedPort = config.port;
    this.lastError = undefined;
    this.configStale = false;
    this.restartAttempted = false;
    this.setState('running');
    this.log.info(`[trigger-server] running on ${config.host}:${actualPort}`);
    return { success: true };
  }

  private async failStart(err: unknown, config: ServerConfig): Promise<RemoteAccessStartResult> {
    const code = (err as { code?: string })?.code;
    let message: string;
    if (code === 'EADDRINUSE') {
      const isOtherInstance = await this.probeForkFingerprint(
        config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host,
        config.port,
      );
      message = isOtherInstance
        ? `Another trigger server instance already holds port ${config.port}`
        : `Port ${config.port} is in use by another application`;
    } else {
      message = err instanceof Error ? err.message : String(err);
    }
    this.lastError = message;
    this.setState('error');
    this.log.error(`[trigger-server] start failed: ${message}`);
    return { success: false, error: message };
  }

  private async teardown(): Promise<void> {
    if (this.state === 'stopped') return;
    this.setState('stopping');

    if (this.stopEviction) {
      this.stopEviction();
      this.stopEviction = null;
    }

    // Order per plan §3: stop accepting → close WS (1001) + drain pool → close listener.
    try {
      if (this.core) {
        await Promise.race([
          this.core.shutdown(),
          new Promise<void>((resolve) => setTimeout(resolve, DRAIN_CAP_MS)),
        ]);
      }
    } catch (err) {
      this.log.error('[trigger-server] core shutdown error', err);
    }

    try {
      if (this.host) await this.host.close();
    } catch (err) {
      this.log.error('[trigger-server] host close error', err);
    }

    this.core = null;
    this.host = null;
    this.startedAt = undefined;
    this.boundHost = undefined;
    this.boundPort = undefined;
    this.boundRequestedPort = undefined;
    this.setState('stopped');
    this.log.info('[trigger-server] stopped');
  }

  private onHostError(err: Error): void {
    this.log.error('[trigger-server] host error', err);
    this.lastError = err.message;
    this.setState('error');

    // One automatic restart attempt for transient faults.
    if (!this.restartAttempted) {
      this.restartAttempted = true;
      setTimeout(() => {
        void this.teardown().then(() => this.startInternal());
      }, AUTO_RESTART_DELAY_MS);
    }
  }

  private async selfHealthCheck(host: string, port: number): Promise<boolean> {
    try {
      const body = await this.healthProbe(host, port);
      return body?.status === 'ok';
    } catch {
      return false;
    }
  }

  private async probeForkFingerprint(host: string, port: number): Promise<boolean> {
    try {
      const body = await this.healthProbe(host, port);
      return body?.fork === 'trigger-server';
    } catch {
      return false;
    }
  }

  private async fetchHealth(host: string, port: number): Promise<{ status?: string; fork?: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as { status?: string; fork?: string };
    } finally {
      clearTimeout(timer);
    }
  }

  private setState(state: RemoteAccessState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(this.getStatus());
  }
}

// ---------------------------------------------------------------------------
// DTO mapping — never leak key hashes across the IPC boundary
// ---------------------------------------------------------------------------

function toKeyInfo(k: {
  id: string; name: string; keyPrefix: string; createdAt: number; lastUsedAt: number | null;
  permissions: ApiKeyPermissions;
}): RemoteAccessApiKeyInfo {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    permissions: {
      workspaceIds: k.permissions.workspaceIds,
      permissionPolicy: k.permissions.permissionPolicy,
      maxConcurrentSessions: k.permissions.maxConcurrentSessions,
    },
  };
}

function toRemoteAccessConfig(config: ServerConfig): RemoteAccessConfig {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    apiKeys: config.apiKeys.map(toKeyInfo),
    rateLimits: {
      requestsPerMinute: config.rateLimits.requestsPerMinute,
      concurrentSessions: config.rateLimits.concurrentSessions,
    },
  };
}
