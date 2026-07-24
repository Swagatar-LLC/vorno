/**
 * fork(PLAN-020): WebUiSupervisor — single source of runtime truth for the
 * embedded browser WebUI listener.
 *
 * Mirrors `TriggerServerSupervisor` (PLAN-012): owns the state machine
 * (stopped → starting → running/error → stopping → stopped), the in-process
 * node:http host, config persistence, and — new here — the WebUI login password
 * and the per-app-run JWT signing secret. The tray reads this directly; the
 * settings page drives it through craft-fork:webui:* IPC.
 *
 * server-config.json (the trigger-server store) is reused; the `webui` block
 * holds desired state. `webui.enabled` is DESIRED: start/stop persist it so a
 * relaunch restores the user's choice (autostart via reconcile()).
 *
 * Auth model (Q1): on first start, generate + persist a 20-char base62 password
 * if none exists. Hold a per-app-run JWT signing secret (crypto.randomUUID, in
 * memory only) — app relaunch invalidates all live sessions. The browser logs
 * in over HTTP (handler /api/auth), receives a craft_session cookie, and that
 * same cookie authenticates its WS-RPC upgrade to the in-process WsRpcServer via
 * `validateSessionCookie`.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadServerConfig,
  saveServerConfig,
  type ServerConfig,
  type WebUiConfig,
} from '@craft-agent/http-trigger/core';
import { validateSession } from '@craft-agent/server-core/webui';
import type { SupervisorLogger } from '../trigger-server/supervisor';
import { createWebUiHandler, type WebUiHandler } from './handler';
import { createWebUiHost, type WebUiHost, type WebUiHostOptions } from './host';
import { TunnelManager } from './tunnel';
import type {
  RemoteAccessState,
  RemoteAccessStartResult,
  TunnelProvider,
  WebUiRemoteConfig,
  WebUiStatus,
} from '../../shared/types';

// fork(PLAN-020): DTOs are defined in shared/types.ts (WS-1). Re-exported here
// for the co-located handler/host/tests that import them from the supervisor.
export type { WebUiRemoteConfig, WebUiStatus };

const HEALTH_TIMEOUT_MS = 3_000;
const AUTO_RESTART_DELAY_MS = 2_000;
const PASSWORD_LENGTH = 20;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const NOOP_LOGGER: SupervisorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Health-probe result shape (the two fields the supervisor inspects). */
export interface WebUiHealthProbeResult {
  status?: string;
  fork?: string;
}

/** Endpoint of the live in-process RPC WS server (for /api/config wsUrl). */
export type WsEndpoint = { port: number; protocol: 'ws' | 'wss' } | undefined;

export interface WebUiSupervisorOptions {
  /** Path to the built WebUI dist/ directory. */
  webuiDir: string;
  /** Returns the live in-process RPC WS endpoint (ephemeral port), or undefined. */
  getWsEndpoint: () => WsEndpoint;
  /** Returns the active workspace id (mirrors upstream getActiveWorkspace). */
  getActiveWorkspaceId?: () => string | null;
  log?: SupervisorLogger;
  /** Called on every state transition so the tray/UI can re-render. */
  onStateChange?: (status: WebUiStatus) => void;
  /** Test seam: build the host (defaults to createWebUiHost). */
  hostFactory?: (handler: WebUiHandler, opts: WebUiHostOptions) => WebUiHost;
  /** Test seam: probe /health (defaults to a real fetch). */
  healthProbe?: (host: string, port: number) => Promise<WebUiHealthProbeResult | null>;
  /** fork(PLAN-022): test seam — the secure-tunnel manager (defaults to a real one). */
  tunnelManager?: TunnelManager;
}

/** Generate a random base62 password of the given length. */
function generatePassword(length = PASSWORD_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % BASE62.length];
  }
  return out;
}

export class WebUiSupervisor {
  private state: RemoteAccessState = 'stopped';
  private host: WebUiHost | null = null;
  private handler: WebUiHandler | null = null;
  private startedAt: number | undefined;
  private lastError: string | undefined;
  private configStale = false;
  private restartAttempted = false;
  private boundHost: string | undefined;
  private boundPort: number | undefined;

  /** Per-app-run JWT signing secret. In-memory only — relaunch ⇒ re-login. */
  private readonly jwtSecret = randomUUID();

  private readonly webuiDir: string;
  private readonly getWsEndpoint: () => WsEndpoint;
  private readonly getActiveWorkspaceId: (() => string | null) | undefined;
  private readonly log: SupervisorLogger;
  private readonly onStateChange: ((status: WebUiStatus) => void) | undefined;
  private readonly hostFactory: (handler: WebUiHandler, opts: WebUiHostOptions) => WebUiHost;
  private readonly healthProbe: (host: string, port: number) => Promise<WebUiHealthProbeResult | null>;
  /** fork(PLAN-022): manages the `tailscale serve` rule fronting the WebUI port. */
  private readonly tunnel: TunnelManager;
  /** The tunnel provider currently brought up (so teardown clears the right rule). */
  private activeTunnelProvider: TunnelProvider = 'none';

  constructor(opts: WebUiSupervisorOptions) {
    this.webuiDir = opts.webuiDir;
    this.getWsEndpoint = opts.getWsEndpoint;
    this.getActiveWorkspaceId = opts.getActiveWorkspaceId;
    this.log = opts.log ?? NOOP_LOGGER;
    this.onStateChange = opts.onStateChange;
    this.hostFactory = opts.hostFactory ?? ((handler, hostOpts) => createWebUiHost(handler.fetch, hostOpts));
    this.healthProbe = opts.healthProbe ?? ((host, port) => this.fetchHealth(host, port));
    this.tunnel = opts.tunnelManager ?? new TunnelManager({ log: this.log });
  }

  // -------------------------------------------------------------------------
  // Public status / config
  // -------------------------------------------------------------------------

  getStatus(): WebUiStatus {
    return {
      running: this.state === 'running',
      state: this.state,
      port: this.boundPort,
      // fork(PLAN-022): surface the actually-bound host so the UI can render
      // truthfully what's listening (loopback / all-interfaces / custom IP).
      host: this.boundHost,
      // The open-in-browser URL stays loopback: even when bound to 0.0.0.0 the
      // local machine reaches it on 127.0.0.1, which avoids leaking an interface
      // IP into a clickable link.
      url: this.state === 'running' && this.boundPort !== undefined
        ? `http://127.0.0.1:${this.boundPort}`
        : undefined,
      startedAt: this.startedAt,
      configStale: this.configStale || undefined,
      lastError: this.lastError,
      // fork(PLAN-022): the managed secure-tunnel's live state (tailscale serve).
      tunnel: this.tunnel.getStatus(),
    };
  }

  /** Sanitized-but-password-bearing config for the renderer (LOCAL_ONLY IPC). */
  getConfig(): WebUiRemoteConfig {
    // fork(BUG-2): NEVER return a null password. Ensure one is generated +
    // persisted first so the settings/tray view always shows a real password
    // (a null here rendered as "–" and made WebUI login impossible until
    // Regenerate rewrote the config).
    this.ensurePassword();
    return toWebUiRemoteConfig(loadServerConfig());
  }

  /**
   * fork(BUG-2): ensure a login password exists on disk, generating + persisting
   * one on first use. Returns the (possibly newly-persisted) password. Shared by
   * startInternal() and getConfig() so neither ever sees a null password.
   */
  private ensurePassword(): string {
    const config = loadServerConfig();
    if (config.webui.password) return config.webui.password;
    const password = generatePassword();
    saveServerConfig({ ...config, webui: { ...config.webui, password } });
    this.log.info('[webui] generated login password on first start');
    return password;
  }

  /**
   * Persist config changes. A live port change surfaces `configStale`
   * ("restart to apply") without tearing down the running listener.
   */
  updateConfig(
    updates: Partial<Pick<WebUiConfig, 'enabled' | 'port' | 'host'>> & {
      tunnel?: { provider?: TunnelProvider; httpsPort?: number };
    },
  ): WebUiRemoteConfig {
    const current = loadServerConfig();
    const nextWebui: WebUiConfig = { ...current.webui, tunnel: { ...current.webui.tunnel } };

    if (typeof updates.enabled === 'boolean') nextWebui.enabled = updates.enabled;
    if (typeof updates.port === 'number') nextWebui.port = updates.port;
    // fork(PLAN-022): host is a persisted bind address; a live change needs a
    // restart to rebind, so it surfaces configStale exactly like a port change.
    if (typeof updates.host === 'string') nextWebui.host = updates.host;

    // fork(PLAN-022): tunnel provider/httpsPort changes apply LIVE (no listener
    // restart) — the tunnel fronts the port from outside the process, so
    // switching provider (or the tailnet HTTPS port) just tears down the old
    // serve rule and brings up the new one. That is why these do NOT set
    // configStale.
    const prevProvider = current.webui.tunnel.provider;
    const prevHttpsPort = current.webui.tunnel.httpsPort ?? 443;
    let tunnelChanged = false;
    if (updates.tunnel !== undefined) {
      if (updates.tunnel.provider !== undefined) {
        nextWebui.tunnel.provider = updates.tunnel.provider;
      }
      if (updates.tunnel.httpsPort !== undefined) {
        nextWebui.tunnel.httpsPort = updates.tunnel.httpsPort;
      }
      const nextHttpsPort = nextWebui.tunnel.httpsPort ?? 443;
      tunnelChanged =
        nextWebui.tunnel.provider !== prevProvider || nextHttpsPort !== prevHttpsPort;
    }

    const next: ServerConfig = { ...current, webui: nextWebui };
    saveServerConfig(next);

    if (
      this.state === 'running' &&
      (nextWebui.port !== this.boundPort || nextWebui.host !== this.boundHost)
    ) {
      this.configStale = true;
      this.emit();
    }

    // Apply a live tunnel provider/port change only when the listener is up (the
    // port must exist to front). Fire-and-forget: the tunnel's own status drives
    // the UI, and an emit() on completion re-renders it. On an httpsPort-only
    // change (same provider) the tunnel's own up() best-effort clears the old
    // served port before serving the new one.
    if (tunnelChanged && this.state === 'running' && this.boundPort !== undefined) {
      void this.applyTunnel(
        prevProvider,
        nextWebui.tunnel.provider,
        this.boundPort,
        nextWebui.tunnel.httpsPort ?? 443,
      );
    }

    return toWebUiRemoteConfig(next);
  }

  /**
   * fork(PLAN-022): switch the live tunnel from `from` to `to`, fronting `port`.
   * Tears down the old serve rule (best-effort) then brings the new one up.
   * Re-emits so the settings UI picks up the new tunnel status.
   */
  private async applyTunnel(
    from: TunnelProvider,
    to: TunnelProvider,
    port: number,
    httpsPort: number,
  ): Promise<void> {
    try {
      if (from !== 'none') await this.tunnel.down(from);
      if (to !== 'none') await this.tunnel.up(to, port, httpsPort);
      this.activeTunnelProvider = to;
    } catch (err) {
      this.log.error('[webui] tunnel apply error', err);
    }
    this.emit();
  }

  /** Regenerate + persist the login password. Live JWT sessions are unaffected. */
  regeneratePassword(): string {
    const config = loadServerConfig();
    const password = generatePassword();
    saveServerConfig({ ...config, webui: { ...config.webui, password } });
    return password;
  }

  /**
   * fork(BUG-2): set a user-chosen stable login password (8–128 chars). Persists
   * it and returns the updated config DTO. Live JWT sessions are unaffected
   * (mirrors regeneratePassword).
   */
  setPassword(password: string): WebUiRemoteConfig {
    const p = password.trim();
    if (p.length < 8 || p.length > 128) {
      throw new Error('Password must be 8–128 characters');
    }
    const config = loadServerConfig();
    const next: ServerConfig = { ...config, webui: { ...config.webui, password: p } };
    saveServerConfig(next);
    return toWebUiRemoteConfig(next);
  }

  /**
   * Validate a craft_session cookie against the per-app-run JWT secret. Wired
   * into `bootstrapServer({ validateSessionCookie })` so the browser's WS-RPC
   * upgrade is authenticated by the WebUI login cookie (Q1).
   */
  async validateSessionCookie(cookieHeader: string | null): Promise<boolean> {
    const payload = await validateSession(cookieHeader, this.jwtSecret);
    return payload !== null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Autostart reconciliation at app launch: start iff webui.enabled. */
  async reconcile(): Promise<void> {
    const config = loadServerConfig();
    if (config.webui.enabled && this.state === 'stopped') {
      this.log.info('[webui] autostart (webui.enabled=true)');
      await this.startInternal();
    }
  }

  /** User/UI start: persist desired-state and start. */
  async start(): Promise<RemoteAccessStartResult> {
    const config = loadServerConfig();
    if (!config.webui.enabled) {
      saveServerConfig({ ...config, webui: { ...config.webui, enabled: true } });
    }
    return this.startInternal();
  }

  /** User/UI stop: persist desired-state and tear down. */
  async stop(): Promise<void> {
    const config = loadServerConfig();
    if (config.webui.enabled) {
      saveServerConfig({ ...config, webui: { ...config.webui, enabled: false } });
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

    // copy-assets.ts promises "the WebUiSupervisor surfaces an actionable error
    // at runtime" when the bundle is missing — this is that surface. Warn (don't
    // fail: /health and the API routes still work) so a bad webuiDir shows up in
    // the main log instead of as bare 404s (LEARNING-026).
    if (!existsSync(join(this.webuiDir, 'index.html'))) {
      this.log.warn(
        `[webui] no index.html under ${this.webuiDir} — WebUI assets missing/mis-staged ` +
        '(dev: run `bun run webui:build`; packaged: staging bug)',
      );
    }

    // Ensure a password exists (generate + persist on first start).
    this.ensurePassword();
    const config = loadServerConfig();

    const password = config.webui.password;
    const host = config.webui.host;
    const port = config.webui.port;

    let handler: WebUiHandler;
    let hostServer: WebUiHost;
    let boundPort: number;
    try {
      handler = createWebUiHandler({
        webuiDir: this.webuiDir,
        secret: this.jwtSecret,
        getPassword: () => loadServerConfig().webui.password,
        getWsEndpoint: this.getWsEndpoint,
        getActiveWorkspaceId: this.getActiveWorkspaceId,
        log: this.log,
      });
      hostServer = this.hostFactory(handler, {
        onError: (err) => this.onHostError(err),
        // fork(PLAN-022): single-port WS proxy seams. The host authenticates the
        // login cookie on `/ws` upgrades and splices them to the loopback RPC
        // endpoint, so remote access needs only this one port.
        validateCookie: (cookieHeader) => this.validateSessionCookie(cookieHeader),
        getWsTarget: () => {
          const endpoint = this.getWsEndpoint();
          return endpoint ? { port: endpoint.port } : undefined;
        },
      });
      // fork(PLAN-020): listen() resolves the actually-bound port (PLAN-018 signature).
      boundPort = await hostServer.listen(host, port);
    } catch (err) {
      try { handler!?.dispose(); } catch { /* ignore */ }
      return this.failStart(err, config);
    }

    // Self health check on the bound listener.
    const healthHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const healthy = await this.selfHealthCheck(healthHost, boundPort);
    if (!healthy) {
      try { await hostServer.close(); } catch { /* ignore */ }
      try { handler.dispose(); } catch { /* ignore */ }
      this.lastError = 'WebUI started but failed its health check';
      this.setState('error');
      return { success: false, error: this.lastError };
    }

    this.handler = handler;
    this.host = hostServer;
    this.startedAt = Date.now();
    this.boundHost = host;
    this.boundPort = boundPort;
    this.lastError = undefined;
    this.configStale = false;
    this.restartAttempted = false;
    this.setState('running');
    this.log.info(`[webui] running on ${host}:${boundPort}`);
    void password; // referenced above for generation; not logged.

    // fork(PLAN-022): bring the secure tunnel up once the listener is live. Fire-
    // and-forget (best-effort): a tunnel failure must never fail the WebUI start —
    // the tunnel's own status surfaces guidance in settings. `applyTunnel` emits
    // when it settles so the UI re-renders.
    const provider = config.webui.tunnel.provider;
    if (provider !== 'none') {
      void this.applyTunnel('none', provider, boundPort, config.webui.tunnel.httpsPort ?? 443);
    } else {
      this.activeTunnelProvider = 'none';
    }
    return { success: true };
  }

  private async failStart(err: unknown, config: ServerConfig): Promise<RemoteAccessStartResult> {
    const code = (err as { code?: string })?.code;
    let message: string;
    if (code === 'EADDRINUSE') {
      const isOtherInstance = await this.probeForkFingerprint(
        config.webui.host === '0.0.0.0' || config.webui.host === '::' ? '127.0.0.1' : config.webui.host,
        config.webui.port,
      );
      message = isOtherInstance
        ? `Another WebUI instance already holds port ${config.webui.port}`
        : `Port ${config.webui.port} is in use by another application`;
    } else {
      message = err instanceof Error ? err.message : String(err);
    }
    this.lastError = message;
    this.setState('error');
    this.log.error(`[webui] start failed: ${message}`);
    return { success: false, error: message };
  }

  private async teardown(): Promise<void> {
    if (this.state === 'stopped') return;
    this.setState('stopping');

    // fork(PLAN-022): tear down the secure tunnel first (best-effort — down()
    // never throws) so we clear the serve rule before the port goes away.
    if (this.activeTunnelProvider !== 'none') {
      await this.tunnel.down(this.activeTunnelProvider);
      this.activeTunnelProvider = 'none';
    }

    try {
      if (this.host) await this.host.close();
    } catch (err) {
      this.log.error('[webui] host close error', err);
    }
    try {
      this.handler?.dispose();
    } catch (err) {
      this.log.error('[webui] handler dispose error', err);
    }

    this.host = null;
    this.handler = null;
    this.startedAt = undefined;
    this.boundHost = undefined;
    this.boundPort = undefined;
    this.setState('stopped');
    this.log.info('[webui] stopped');
  }

  private onHostError(err: Error): void {
    this.log.error('[webui] host error', err);
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
      return body?.fork === 'webui';
    } catch {
      return false;
    }
  }

  private async fetchHealth(host: string, port: number): Promise<WebUiHealthProbeResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as WebUiHealthProbeResult;
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
// DTO mapping
// ---------------------------------------------------------------------------

function toWebUiRemoteConfig(config: ServerConfig): WebUiRemoteConfig {
  return {
    enabled: config.webui.enabled,
    port: config.webui.port,
    // fork(PLAN-022): bind address, surfaced in the Remote Access host dropdown.
    host: config.webui.host,
    // The password IS intentionally exposed over LOCAL_ONLY IPC (settings/tray).
    password: config.webui.password,
    // fork(PLAN-022): secure-tunnel provider selection + tailnet HTTPS port.
    tunnel: {
      provider: config.webui.tunnel.provider,
      httpsPort: config.webui.tunnel.httpsPort,
    },
  };
}
