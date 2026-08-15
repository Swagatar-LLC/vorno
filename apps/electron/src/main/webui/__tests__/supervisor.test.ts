/**
 * fork(PLAN-020): WebUiSupervisor state-machine tests.
 *
 * Uses injected test seams (hostFactory + healthProbe) so no real listener or
 * network is stood up. CRAFT_CONFIG_DIR is claimed by the bunfig [test]
 * preload before any module evaluates, so CONFIG_DIR freezes to a throwaway
 * temp dir.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';

// This file writes config through the real save/loadServerConfig, which target
// the frozen CONFIG_DIR. That is safe ONLY because the bunfig [test] preload
// claims CRAFT_CONFIG_DIR before any module graph evaluates. A module-scope
// env assignment here cannot provide that guarantee — ES imports hoist above
// it, and with sibling files sharing the process the frozen dir was the LIVE
// config dir, so this suite rewrote the running app's WebUI password while
// reporting 85 pass / 0 fail (LEARNING-056).

import type { WebUiHandler } from '../handler';
import type { WebUiHostOptions } from '../host';

let WebUiSupervisor: typeof import('../supervisor').WebUiSupervisor;
let loadServerConfig: typeof import('@craft-agent/http-trigger/core').loadServerConfig;
let saveServerConfig: typeof import('@craft-agent/http-trigger/core').saveServerConfig;

function writeConfig(
  webuiEnabled: boolean,
  port = 3999,
  password: string | null = null,
  tunnelProvider: 'none' | 'tailscale' = 'none',
) {
  saveServerConfig({
    enabled: true,
    port: 3847,
    host: '127.0.0.1',
    apiKeys: [],
    rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
    webui: { enabled: webuiEnabled, port, host: '127.0.0.1', password, tunnel: { provider: tunnelProvider } },
  });
}

function readConfig() {
  return loadServerConfig();
}

/** In-memory fake host. */
function makeFakeHost(listenError?: unknown) {
  const calls = { listen: [] as Array<[string, number]>, closed: 0 };
  const host = {
    async listen(h: string, p: number): Promise<number> {
      calls.listen.push([h, p]);
      if (listenError) throw listenError;
      return p; // fork(PLAN-020): listen() resolves the bound port (PLAN-018 signature)
    },
    async close() { calls.closed++; },
  };
  return { host, calls };
}

const okProbe = async () => ({ status: 'ok', fork: 'webui' });
const getWsEndpoint = () => ({ port: 5555, protocol: 'ws' as const });

/** fork(PLAN-022): a fake TunnelManager recording up/down calls. */
function makeFakeTunnel() {
  const calls = {
    up: [] as Array<[string, number]>,
    upHttpsPort: [] as Array<number | undefined>,
    down: [] as string[],
  };
  let status = { provider: 'none' as 'none' | 'tailscale', state: 'stopped' as string };
  const tunnel = {
    getStatus() { return status; },
    async up(provider: 'none' | 'tailscale', port: number, httpsPort?: number) {
      calls.up.push([provider, port]);
      calls.upHttpsPort.push(httpsPort);
      status = { provider, state: provider === 'none' ? 'stopped' : 'running' };
      return status;
    },
    async down(provider: 'none' | 'tailscale') {
      calls.down.push(provider);
      status = { provider, state: 'stopped' };
    },
  };
  return { tunnel, calls };
}

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    webuiDir: '/tmp/does-not-matter',
    getWsEndpoint,
    healthProbe: okProbe,
    ...overrides,
  };
}

beforeAll(async () => {
  ({ WebUiSupervisor } = await import('../supervisor'));
  ({ loadServerConfig, saveServerConfig } = await import('@craft-agent/http-trigger/core'));
  void loadServerConfig; void saveServerConfig;
});

let active: InstanceType<typeof WebUiSupervisor> | null = null;
afterEach(async () => {
  if (active) { await active.dispose(); active = null; }
});

describe('WebUiSupervisor state machine', () => {
  test('start → running, persists webui.enabled=true (desired state)', async () => {
    writeConfig(false, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(true);
    const status = sup.getStatus();
    expect(status.state).toBe('running');
    expect(status.running).toBe(true);
    expect(status.port).toBe(3999);
    expect(status.url).toBe('http://127.0.0.1:3999');
    expect(readConfig().webui.enabled).toBe(true);
  });

  test('stop → stopped, persists webui.enabled=false', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host, calls } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    await sup.stop();
    expect(sup.getStatus().state).toBe('stopped');
    expect(calls.closed).toBeGreaterThanOrEqual(1);
    expect(readConfig().webui.enabled).toBe(false);
  });

  test('dispose does not touch desired state', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    await sup.dispose();
    active = null;
    expect(readConfig().webui.enabled).toBe(true); // untouched
  });

  test('generates + persists a 20-char base62 password on first start', async () => {
    writeConfig(true, 3999, null);
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    const pw = readConfig().webui.password as string;
    expect(typeof pw).toBe('string');
    expect(pw.length).toBe(20);
    expect(pw).toMatch(/^[A-Za-z0-9]{20}$/);
    // Exposed over LOCAL_ONLY IPC (settings/tray).
    expect(sup.getConfig().password).toBe(pw);
  });

  test('regeneratePassword replaces + persists the password', async () => {
    writeConfig(true, 3999, 'old-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    const next = sup.regeneratePassword();
    expect(next.length).toBe(20);
    expect(next).not.toBe('old-password');
    expect(readConfig().webui.password).toBe(next);
  });

  test('EADDRINUSE by another WebUI → error with instance message', async () => {
    writeConfig(false, 3999, 'seed-password');
    const { host } = makeFakeHost(Object.assign(new Error('bind'), { code: 'EADDRINUSE' }));
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host, healthProbe: okProbe }));
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(false);
    expect(sup.getStatus().state).toBe('error');
    expect(result.error).toContain('Another WebUI');
  });

  test('EADDRINUSE by unrelated app → generic port-in-use message', async () => {
    writeConfig(false, 3999, 'seed-password');
    const { host } = makeFakeHost(Object.assign(new Error('bind'), { code: 'EADDRINUSE' }));
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host, healthProbe: async () => null }));
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(false);
    expect(result.error).toContain('in use by another application');
  });

  test('failed health check → error state', async () => {
    writeConfig(false, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host, healthProbe: async () => null }));
    active = sup;

    const result = await sup.start();
    expect(result.success).toBe(false);
    expect(sup.getStatus().state).toBe('error');
    expect(result.error).toContain('health check');
  });

  test('reconcile autostarts iff webui.enabled=true', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.reconcile();
    expect(sup.getStatus().state).toBe('running');
  });

  test('reconcile is a no-op when webui.enabled=false', async () => {
    writeConfig(false, 3999, 'seed-password');
    const { host, calls } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.reconcile();
    expect(sup.getStatus().state).toBe('stopped');
    expect(calls.listen.length).toBe(0);
  });

  test('updateConfig live port change sets configStale', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    expect(sup.getStatus().configStale).toBeUndefined();
    sup.updateConfig({ port: 4001 });
    expect(sup.getStatus().configStale).toBe(true);
    expect(readConfig().webui.port).toBe(4001);
  });

  // fork(PLAN-022): host bind-address is now surfaced + editable in settings.
  test('updateConfig persists host to disk and surfaces it in config', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    const returned = sup.updateConfig({ host: '0.0.0.0' });
    expect(returned.host).toBe('0.0.0.0');
    expect(readConfig().webui.host).toBe('0.0.0.0');
  });

  test('updateConfig live host change sets configStale', async () => {
    writeConfig(true, 3999, 'seed-password'); // seeds host '127.0.0.1'
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    expect(sup.getStatus().configStale).toBeUndefined();
    // Bound host is 127.0.0.1; changing to 0.0.0.0 needs a restart to rebind.
    sup.updateConfig({ host: '0.0.0.0' });
    expect(sup.getStatus().configStale).toBe(true);
    expect(readConfig().webui.host).toBe('0.0.0.0');
  });

  test('updateConfig host unchanged from bound value does NOT set configStale', async () => {
    writeConfig(true, 3999, 'seed-password'); // host '127.0.0.1'
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    sup.updateConfig({ host: '127.0.0.1' });
    expect(sup.getStatus().configStale).toBeUndefined();
  });

  test('getStatus surfaces the bound host while running', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    await sup.start();
    expect(sup.getStatus().host).toBe('127.0.0.1');
  });

  test('startInternal wires the WS-proxy seams into the host (PLAN-022)', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    let captured: import('../host').WebUiHostOptions | undefined;
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: (_handler: WebUiHandler, opts: WebUiHostOptions) => { captured = opts; return host; },
      getWsEndpoint: () => ({ port: 6161, protocol: 'ws' as const }),
    }));
    active = sup;

    await sup.start();

    // The host received both single-port-proxy seams.
    expect(typeof captured?.validateCookie).toBe('function');
    expect(typeof captured?.getWsTarget).toBe('function');

    // getWsTarget projects the live RPC endpoint's port.
    expect(captured!.getWsTarget!()).toEqual({ port: 6161 });

    // validateCookie is the supervisor's own cookie validator: a cookie minted
    // with the per-run secret passes; garbage fails.
    const { createSessionToken } = await import('@craft-agent/server-core/webui');
    const secret = (sup as unknown as { jwtSecret: string }).jwtSecret;
    const jwt = await createSessionToken(secret);
    expect(await captured!.validateCookie!(`craft_session=${jwt}`)).toBe(true);
    expect(await captured!.validateCookie!(null)).toBe(false);
  });

  test('getWsTarget returns undefined when the RPC endpoint is down (PLAN-022)', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    let captured: import('../host').WebUiHostOptions | undefined;
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: (_handler: WebUiHandler, opts: WebUiHostOptions) => { captured = opts; return host; },
      getWsEndpoint: () => undefined,
    }));
    active = sup;
    await sup.start();
    expect(captured!.getWsTarget!()).toBeUndefined();
  });

  test('validateSessionCookie: full JWT round-trip via upstream createSessionToken', async () => {
    writeConfig(true, 3999, 'my-secret-pw');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;
    await sup.start();

    // Mint a craft_session cookie signed with the supervisor's per-run secret
    // (the same path the handler's /api/auth uses) and validate it back.
    const { createSessionToken, buildSessionCookie } = await import('@craft-agent/server-core/webui');
    // Access the per-run secret the supervisor generated (in-memory only).
    const secret = (sup as unknown as { jwtSecret: string }).jwtSecret;
    const jwt = await createSessionToken(secret);
    const cookie = buildSessionCookie(jwt, false); // "craft_session=<jwt>; HttpOnly; ..."
    const cookieHeader = cookie.split(';')[0]; // browsers send only name=value on requests

    expect(await sup.validateSessionCookie(cookieHeader)).toBe(true);
    // Negative cases.
    expect(await sup.validateSessionCookie(null)).toBe(false);
    expect(await sup.validateSessionCookie('craft_session=not-a-jwt')).toBe(false);

    // A cookie signed with a different secret must be rejected.
    const otherJwt = await createSessionToken('some-other-secret');
    expect(await sup.validateSessionCookie(`craft_session=${otherJwt}`)).toBe(false);
  });

  // fork(PLAN-022): secure-tunnel wiring.
  test('tunnel is brought up on start when provider=tailscale', async () => {
    writeConfig(true, 3999, 'seed-password', 'tailscale');
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    // Give the fire-and-forget applyTunnel a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.up).toEqual([['tailscale', 3999]]);
    expect(sup.getStatus().tunnel?.state).toBe('running');
  });

  test('tunnel is NOT brought up when provider=none', async () => {
    writeConfig(true, 3999, 'seed-password', 'none');
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.up.length).toBe(0);
  });

  test('tunnel is torn down on stop', async () => {
    writeConfig(true, 3999, 'seed-password', 'tailscale');
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    await new Promise((r) => setTimeout(r, 0));
    await sup.stop();

    expect(calls.down).toContain('tailscale');
  });

  test('live provider change from none→tailscale applies without a listener restart', async () => {
    writeConfig(true, 3999, 'seed-password', 'none');
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.up.length).toBe(0);

    const returned = sup.updateConfig({ tunnel: { provider: 'tailscale' } });
    expect(returned.tunnel.provider).toBe('tailscale');
    await new Promise((r) => setTimeout(r, 0));

    // Provider change applied live; no configStale (tunnel fronts from outside).
    expect(calls.up).toEqual([['tailscale', 3999]]);
    expect(sup.getStatus().configStale).toBeUndefined();
    expect(readConfig().webui.tunnel.provider).toBe('tailscale');
  });

  test('getConfig surfaces the tunnel provider', async () => {
    writeConfig(true, 3999, 'seed-password', 'tailscale');
    const { host } = makeFakeHost();
    const { tunnel } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;
    expect(sup.getConfig().tunnel.provider).toBe('tailscale');
  });

  // fork(BUG-2): user-settable stable password + no-null-password invariant.
  test('setPassword persists a stable password that survives a reload', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    const returned = sup.setPassword('my-stable-pw-123');
    expect(returned.password).toBe('my-stable-pw-123');
    // Survives a fresh loadServerConfig round-trip.
    expect(readConfig().webui.password).toBe('my-stable-pw-123');
  });

  test('setPassword rejects too-short / too-long passwords', async () => {
    writeConfig(true, 3999, 'seed-password');
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;
    expect(() => sup.setPassword('short')).toThrow();
    expect(() => sup.setPassword('x'.repeat(129))).toThrow();
  });

  test('getConfig NEVER returns a null password (ensurePassword generates one)', async () => {
    writeConfig(true, 3999, null); // no password on disk
    const { host } = makeFakeHost();
    const sup = new WebUiSupervisor(baseOpts({ hostFactory: () => host }));
    active = sup;

    const cfg = sup.getConfig();
    expect(cfg.password).toBeTruthy();
    expect(cfg.password).not.toBeNull();
    // And it was persisted, not just returned.
    expect(readConfig().webui.password).toBe(cfg.password);
  });

  // fork(BUG-3): custom tailnet HTTPS port is plumbed through to the tunnel.
  test('startInternal plumbs the configured httpsPort into tunnel.up', async () => {
    saveServerConfig({
      enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [],
      rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
      webui: { enabled: true, port: 3999, host: '127.0.0.1', password: 'seed-password', tunnel: { provider: 'tailscale', httpsPort: 8443 } },
    });
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.up).toEqual([['tailscale', 3999]]);
    expect(calls.upHttpsPort).toEqual([8443]);
  });

  test('updateConfig live httpsPort change re-applies the tunnel (same provider)', async () => {
    saveServerConfig({
      enabled: true, port: 3847, host: '127.0.0.1', apiKeys: [],
      rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
      webui: { enabled: true, port: 3999, host: '127.0.0.1', password: 'seed-password', tunnel: { provider: 'tailscale', httpsPort: 443 } },
    });
    const { host } = makeFakeHost();
    const { tunnel, calls } = makeFakeTunnel();
    const sup = new WebUiSupervisor(baseOpts({
      hostFactory: () => host,
      tunnelManager: tunnel as unknown as import('../tunnel').TunnelManager,
    }));
    active = sup;

    await sup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.upHttpsPort).toEqual([443]);

    const returned = sup.updateConfig({ tunnel: { httpsPort: 8443 } });
    expect(returned.tunnel.httpsPort).toBe(8443);
    await new Promise((r) => setTimeout(r, 0));

    // Re-applied live: down old, up on the new port; no configStale.
    expect(calls.down).toContain('tailscale');
    expect(calls.upHttpsPort).toEqual([443, 8443]);
    expect(sup.getStatus().configStale).toBeUndefined();
    expect(readConfig().webui.tunnel.httpsPort).toBe(8443);
  });
});
