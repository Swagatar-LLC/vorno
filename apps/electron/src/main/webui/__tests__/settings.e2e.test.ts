/**
 * fork(109de9f5): settings-driven coverage for the three remote-access field
 * fixes from the first real-device Tailscale test. The sibling unit suites
 * (supervisor/tunnel/config/ws-url) cover each seam in isolation; this suite
 * exercises the SETTINGS PATH the field bugs actually travelled: the
 * craft-fork:webui:* IPC handlers → WebUiSupervisor → persisted
 * server-config.json → (for the tunnel) the exact CLI args handed to
 * `tailscale serve`, and (for the WS URL) the real /api/config response as a
 * proto-stripping HTTPS proxy would produce it.
 *
 * Every test here is a revert detector: it fails if its fix is backed out.
 *   BUG-1  wss over HTTPS proxy   — resolvePageWsUrl upgrade + App.tsx wiring
 *   BUG-2  password persistence   — SET_PASSWORD channel, ensurePassword on
 *                                   corrupt config, atomic save preserves the
 *                                   old file when the write fails
 *   BUG-3  tunnel HTTPS port      — --https=<port> in up/off, stale-rule clear
 *                                   on live port switch, teardown targets the
 *                                   served port (not hardcoded 443)
 *
 * CRAFT_CONFIG_DIR is claimed by the bunfig [test] preload before any module
 * evaluates (a module-scope assignment here would be dead code — ES imports
 * hoist above it, LEARNING-056). Sibling test files share the process, so the
 * file paths used below are derived from the ACTUAL frozen CONFIG_DIR, never
 * guessed.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolvePageWsUrl } from '../../../../../webui/src/adapter/ws-url';
import type { WebUiHandler } from '../handler';
import type { WebUiHostOptions } from '../host';
import type { RpcServer } from '@craft-agent/server-core/transport';

let WebUiSupervisor: typeof import('../supervisor').WebUiSupervisor;
let TunnelManager: typeof import('../tunnel').TunnelManager;
let registerWebUiHandlers: typeof import('../../handlers/webui').registerWebUiHandlers;
let RPC_CHANNELS: typeof import('@craft-agent/shared/protocol').RPC_CHANNELS;
let loadServerConfig: typeof import('@craft-agent/http-trigger/core').loadServerConfig;
let saveServerConfig: typeof import('@craft-agent/http-trigger/core').saveServerConfig;
/** The frozen config root the config module actually uses (not the env var). */
let configDir: string;
let configPath: string;

beforeAll(async () => {
  ({ WebUiSupervisor } = await import('../supervisor'));
  ({ TunnelManager } = await import('../tunnel'));
  ({ registerWebUiHandlers } = await import('../../handlers/webui'));
  ({ RPC_CHANNELS } = await import('@craft-agent/shared/protocol'));
  ({ loadServerConfig, saveServerConfig } = await import('@craft-agent/http-trigger/core'));
  // Same module config.ts derives CONFIG_PATH from — frozen at first eval, so
  // this is the real on-disk location regardless of sibling import order.
  ({ CONFIG_DIR: configDir } = await import('@craft-agent/shared/config/paths'));
  configPath = join(configDir, 'server-config.json');
});

// ---------------------------------------------------------------------------
// Harness: fake IPC bus + fake host + recording exec for a REAL TunnelManager
// ---------------------------------------------------------------------------

/** Fake RpcServer capturing handle() registrations; invoke() drives a channel. */
function makeIpcBus() {
  const handlers = new Map<string, (ctx: unknown, ...args: unknown[]) => Promise<unknown>>();
  const server = {
    handle: (channel: string, fn: (ctx: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  } as unknown as RpcServer;
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler registered for ${channel}`);
    return fn({}, ...args);
  };
  return { server, invoke };
}

/** In-memory fake host (the listener itself is not under test here). */
function makeFakeHost() {
  return {
    async listen(_h: string, p: number): Promise<number> { return p; },
    async close() {},
  };
}

/** Recording exec seam for a REAL TunnelManager — captures exact CLI args. */
function makeExecRecorder() {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === 'status') {
      return { stdout: '{"Self":{"DNSName":"vorno-test.tail.ts.net."}}', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  /** All `serve …` invocations (drops the `status --json` noise). */
  const serveCalls = () => calls.filter((c) => c[1] === 'serve').map((c) => c.slice(1));
  return { exec, calls, serveCalls };
}

function writeConfig(opts: {
  password?: string | null;
  provider?: 'none' | 'tailscale';
  httpsPort?: number;
  webuiPort?: number;
} = {}) {
  saveServerConfig({
    enabled: true,
    port: 3847,
    host: '127.0.0.1',
    apiKeys: [],
    rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
    webui: {
      enabled: false,
      port: opts.webuiPort ?? 3999,
      host: '127.0.0.1',
      password: opts.password === undefined ? 'seed-password-123' : opts.password,
      tunnel: {
        provider: opts.provider ?? 'none',
        ...(opts.httpsPort !== undefined ? { httpsPort: opts.httpsPort } : {}),
      },
    },
  });
}

const okProbe = async () => ({ status: 'ok', fork: 'webui' });

/** Supervisor + registered IPC handlers on a fake bus (the settings surface). */
function makeSettingsSurface(overrides: Record<string, unknown> = {}) {
  const sup = new WebUiSupervisor({
    webuiDir: '/tmp/does-not-matter',
    getWsEndpoint: () => ({ port: 5555, protocol: 'ws' as const }),
    healthProbe: okProbe,
    hostFactory: () => makeFakeHost(),
    ...overrides,
  } as ConstructorParameters<typeof WebUiSupervisor>[0]);
  const { server, invoke } = makeIpcBus();
  registerWebUiHandlers(server, sup);
  return { sup, invoke };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

let active: InstanceType<typeof WebUiSupervisor> | null = null;
afterEach(async () => {
  if (active) { await active.dispose(); active = null; }
});

// ---------------------------------------------------------------------------
// BUG-1 — wss over an HTTPS proxy that strips x-forwarded-proto
// ---------------------------------------------------------------------------

describe('BUG-1: wss URL derivation behind an HTTPS proxy', () => {
  test('proto-stripping proxy: /api/config says ws://, the client resolves wss://', async () => {
    // Real handler + host on an ephemeral port — the same /api/config the
    // browser hits. `tailscale serve` terminates TLS but does NOT forward
    // x-forwarded-proto, so the server sees a plain-HTTP request and returns
    // ws:// even though the page is https:.
    const webuiDir = mkdtempSync(join(tmpdir(), 'webui-bug1-'));
    const { createWebUiHandler } = await import('../handler');
    const { createWebUiHost } = await import('../host');
    const PASSWORD = 'bug1-password-123';
    const SECRET = 'bug1-secret';
    const handler: WebUiHandler = createWebUiHandler({
      webuiDir,
      secret: SECRET,
      getPassword: () => PASSWORD,
      getWsEndpoint: () => ({ port: 5555, protocol: 'ws' }),
    });
    const host = createWebUiHost(handler.fetch, {} as WebUiHostOptions);
    const port = await host.listen('127.0.0.1', 0);
    try {
      const auth = await fetch(`http://127.0.0.1:${port}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(auth.status).toBe(200);
      const cookie = (auth.headers.get('set-cookie') ?? '').match(/craft_session=[^;]+/)![0];

      // No x-forwarded-proto (the tailscale-serve reality) → server says ws://.
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const { wsUrl } = (await res.json()) as { wsUrl: string };
      expect(wsUrl).toBe(`ws://127.0.0.1:${port}/ws`);

      // The client-side fix: an https: page upgrades that to wss://, preserving
      // authority + path. Reverting resolvePageWsUrl leaves ws:// here → the
      // browser rejects it as mixed content.
      expect(resolvePageWsUrl(wsUrl, 'https:')).toBe(`wss://127.0.0.1:${port}/ws`);
      // http: page keeps ws:// (local/plain use unchanged).
      expect(resolvePageWsUrl(wsUrl, 'http:')).toBe(wsUrl);

      // A proxy that DOES forward x-forwarded-proto gets wss:// server-side and
      // the client resolution is a no-op (idempotent, never double-upgrades).
      const res2 = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { Cookie: cookie, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'vorno.tail.ts.net' },
      });
      const { wsUrl: wssUrl } = (await res2.json()) as { wsUrl: string };
      expect(wssUrl).toBe('wss://vorno.tail.ts.net/ws');
      expect(resolvePageWsUrl(wssUrl, 'https:')).toBe(wssUrl);
    } finally {
      await host.close();
      handler.dispose();
      rmSync(webuiDir, { recursive: true, force: true });
    }
  });

  test('never downgrades wss:// on an http: page', () => {
    expect(resolvePageWsUrl('wss://vorno.tail.ts.net/ws', 'http:')).toBe('wss://vorno.tail.ts.net/ws');
  });

  test('App.tsx pipes the server wsUrl through resolvePageWsUrl (wiring revert guard)', () => {
    // Source-level guard: the helper being correct is worthless if App.tsx
    // stops calling it. Assert the wiring line survives.
    const appSrc = readFileSync(
      join(import.meta.dir, '../../../../../webui/src/App.tsx'),
      'utf-8',
    );
    expect(appSrc).toContain("import { resolvePageWsUrl } from './adapter/ws-url'");
    expect(appSrc).toContain('resolvePageWsUrl(rawWsUrl, window.location.protocol)');
  });
});

// ---------------------------------------------------------------------------
// BUG-2 — password persistence / never-null invariant
// ---------------------------------------------------------------------------

describe('BUG-2: WebUI password persistence via the settings IPC surface', () => {
  test('SET_PASSWORD persists; a fresh supervisor (app relaunch) serves the same password', async () => {
    writeConfig({ password: 'seed-password-123' });
    const s1 = makeSettingsSurface();
    active = s1.sup;

    const dto = (await s1.invoke(RPC_CHANNELS.webui.SET_PASSWORD, 'my-stable-pass')) as { password: string };
    expect(dto.password).toBe('my-stable-pass');
    await s1.sup.dispose();
    active = null;

    // Simulated relaunch: brand-new supervisor + IPC registration, same disk.
    const s2 = makeSettingsSurface();
    active = s2.sup;
    const cfg = (await s2.invoke(RPC_CHANNELS.webui.GET_CONFIG)) as { password: string };
    expect(cfg.password).toBe('my-stable-pass');
    expect(loadServerConfig().webui.password).toBe('my-stable-pass');
  });

  test('SET_PASSWORD IPC boundary: non-string rejected, 8–128 length enforced, value trimmed', async () => {
    writeConfig({ password: 'seed-password-123' });
    const { sup, invoke } = makeSettingsSurface();
    active = sup;

    await expect(invoke(RPC_CHANNELS.webui.SET_PASSWORD, 12345)).rejects.toThrow('must be a string');
    await expect(invoke(RPC_CHANNELS.webui.SET_PASSWORD, { pw: 'x' })).rejects.toThrow('must be a string');
    await expect(invoke(RPC_CHANNELS.webui.SET_PASSWORD, 'short')).rejects.toThrow('8–128');
    await expect(invoke(RPC_CHANNELS.webui.SET_PASSWORD, 'x'.repeat(129))).rejects.toThrow('8–128');
    // Boundary lengths pass; surrounding whitespace is trimmed before storing.
    await invoke(RPC_CHANNELS.webui.SET_PASSWORD, '  padded-pass-1  ');
    expect(loadServerConfig().webui.password).toBe('padded-pass-1');
  });

  test('corrupt server-config.json: load preserves the file; GET_CONFIG still yields a password', async () => {
    writeConfig({ password: 'persist-me-123' });
    // Torn write on disk (e.g. power loss with the OLD non-atomic save).
    const garbage = '{"webui": {"password": "persist-me-1';
    writeFileSync(configPath, garbage, 'utf-8');

    // The load path warns + falls back in memory but leaves the file byte-for-
    // byte intact (a torn file may be hand-recoverable).
    const loaded = loadServerConfig();
    expect(loaded.webui.password).toBeNull(); // in-memory defaults only
    expect(readFileSync(configPath, 'utf-8')).toBe(garbage);

    // The settings surface never shows "–": GET_CONFIG generates + persists a
    // real password (pre-fix this returned null → unusable login).
    const { sup, invoke } = makeSettingsSurface();
    active = sup;
    const cfg = (await invoke(RPC_CHANNELS.webui.GET_CONFIG)) as { password: string | null };
    expect(cfg.password).toBeTruthy();
    expect(cfg.password!.length).toBe(20);
    expect(loadServerConfig().webui.password).toBe(cfg.password);
  });

  test('atomic save: a failed write preserves the previous config and leaves no temp litter', () => {
    writeConfig({ password: 'survives-the-crash' });
    const before = readFileSync(configPath, 'utf-8');

    // Make the config dir unwritable: the atomic temp-file create fails, so
    // save must throw AND leave the old file untouched. (The pre-fix direct
    // writeFileSync would SUCCEED here — truncating/overwriting the existing
    // file needs only file perms, not dir perms — so this discriminates.)
    chmodSync(configDir, 0o555);
    try {
      expect(() =>
        saveServerConfig({ ...loadServerConfig(), webui: { ...loadServerConfig().webui, password: 'clobber' } }),
      ).toThrow();
    } finally {
      chmodSync(configDir, 0o755);
    }
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(loadServerConfig().webui.password).toBe('survives-the-crash');
    // Failed attempt cleaned up its temp file; a successful save leaves none either.
    expect(readdirSync(configDir).filter((f) => f.includes('server-config.json.tmp'))).toEqual([]);
    saveServerConfig(loadServerConfig());
    expect(readdirSync(configDir).filter((f) => f.includes('server-config.json.tmp'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG-3 — tunnel HTTPS port lifecycle (settings → supervisor → exact CLI args)
// ---------------------------------------------------------------------------

describe('BUG-3: tunnel httpsPort via the settings IPC surface', () => {
  function makeTunnelSurface() {
    const rec = makeExecRecorder();
    const tunnel = new TunnelManager({ exec: rec.exec, locateBinary: async () => 'tailscale' });
    const surface = makeSettingsSurface({ tunnelManager: tunnel });
    return { ...surface, ...rec };
  }

  test('configured httpsPort drives the exact `tailscale serve` args on start', async () => {
    writeConfig({ provider: 'tailscale', httpsPort: 8443 });
    const { sup, invoke, serveCalls } = makeTunnelSurface();
    active = sup;

    const result = (await invoke(RPC_CHANNELS.webui.START)) as { success: boolean };
    expect(result.success).toBe(true);
    await tick();

    // Reverting BUG-3 hardcodes --https=443 here.
    expect(serveCalls()).toEqual([
      ['serve', '--bg', '--https=8443', 'http://127.0.0.1:3999'],
    ]);
  });

  test('live httpsPort change via UPDATE_CONFIG: old rule cleared, new port served, no restart', async () => {
    writeConfig({ provider: 'tailscale', httpsPort: 8443 });
    const { sup, invoke, serveCalls } = makeTunnelSurface();
    active = sup;

    await invoke(RPC_CHANNELS.webui.START);
    await tick();

    // httpsPort-only update — provider intentionally omitted (it became
    // optional in this fix; pre-fix updates required it).
    const dto = (await invoke(RPC_CHANNELS.webui.UPDATE_CONFIG, { tunnel: { httpsPort: 9443 } })) as {
      tunnel: { provider: string; httpsPort?: number };
    };
    expect(dto.tunnel.httpsPort).toBe(9443);
    await tick();

    // The old serve rule on 8443 is cleared BEFORE the new rule on 9443 goes
    // up — no stale rule left fronting the dead port.
    expect(serveCalls()).toEqual([
      ['serve', '--bg', '--https=8443', 'http://127.0.0.1:3999'],
      ['serve', '--https=8443', 'off'],
      ['serve', '--bg', '--https=9443', 'http://127.0.0.1:3999'],
    ]);

    // Applied live: no "restart to apply" flag; persisted to disk; DTO round-trips.
    const status = (await invoke(RPC_CHANNELS.webui.GET_STATUS)) as { configStale?: boolean };
    expect(status.configStale).toBeUndefined();
    expect(loadServerConfig().webui.tunnel.httpsPort).toBe(9443);
    const cfg = (await invoke(RPC_CHANNELS.webui.GET_CONFIG)) as { tunnel: { httpsPort?: number } };
    expect(cfg.tunnel.httpsPort).toBe(9443);
  });

  test('STOP tears down the actually-served port, not hardcoded 443', async () => {
    writeConfig({ provider: 'tailscale', httpsPort: 8443 });
    const { sup, invoke, serveCalls } = makeTunnelSurface();
    active = sup;

    await invoke(RPC_CHANNELS.webui.START);
    await tick();
    await invoke(RPC_CHANNELS.webui.STOP);
    await tick();

    const offCalls = serveCalls().filter((c) => c[c.length - 1] === 'off');
    // Reverting BUG-3 makes this ['serve', '--https=443', 'off'] — which would
    // leave the real 8443 rule stranded on the tailnet after quit.
    expect(offCalls).toEqual([['serve', '--https=8443', 'off']]);
  });

  test('UPDATE_CONFIG IPC boundary: httpsPort range/integer validation, extremes accepted', async () => {
    writeConfig({ provider: 'none' });
    const { sup, invoke } = makeSettingsSurface();
    active = sup;

    for (const bad of [0, 65536, 1.5, -443]) {
      await expect(
        invoke(RPC_CHANNELS.webui.UPDATE_CONFIG, { tunnel: { httpsPort: bad } }),
      ).rejects.toThrow('between 1 and 65535');
    }
    await invoke(RPC_CHANNELS.webui.UPDATE_CONFIG, { tunnel: { httpsPort: 1 } });
    expect(loadServerConfig().webui.tunnel.httpsPort).toBe(1);
    await invoke(RPC_CHANNELS.webui.UPDATE_CONFIG, { tunnel: { httpsPort: 65535 } });
    expect(loadServerConfig().webui.tunnel.httpsPort).toBe(65535);
  });
});
