/**
 * fork(PLAN-020/PLAN-022): headless WebUI smoke suite.
 *
 * The committed replacement for the manual smoke pass PLAN-020 left behind and
 * the ad-hoc e2e PLAN-022 ran but never committed. Boots the REAL stack —
 * `createWebUiHandler` wired through `createWebUiHost` onto a real ephemeral
 * `node:http` listener — and exercises it over real TCP: health probe, login
 * (reject + accept + cookie issue), cookie-gated `/api/config` wsUrl, the
 * unauthenticated `/` → `/login` redirect (LEARNING-026 regression), and the
 * single-port `/ws` proxy (auth reject + authenticated splice to a loopback
 * "RPC" target with a bidirectional echo). No display, no Electron, no manual
 * auth — CI-safe by construction.
 *
 * Bun ≥1.3 emits `upgrade` on `node:http` servers and delivers inbound bytes,
 * but writes to the upgraded socket never reach the client (LEARNING-038), so
 * this suite asserts the FORWARD splice leg + auth gating through the real
 * listener; the reverse leg (target→client bytes) is covered by host.test.ts,
 * which drives `handleWsUpgrade` directly. The packaged app runs on Node,
 * where both directions work (verified manually in PLAN-022).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, connect, type Server, type Socket } from 'node:net';
import { validateSession } from '@craft-agent/server-core/webui';
import { createWebUiHandler, type WebUiHandler } from '../handler';
import { createWebUiHost, type WebUiHost } from '../host';

const PASSWORD = 'smoke-test-password';
const SECRET = 'smoke-test-secret';

let webuiDir: string;
let handler: WebUiHandler;
let host: WebUiHost;
let port: number;
let rpcTarget: Server;
let rpcPort: number;
/** Raw bytes the fake RPC target received on its most recent connection. */
let rpcReceived = '';

function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

/** Log in and return the craft_session cookie pair ("craft_session=<jwt>"). */
async function login(): Promise<string> {
  const res = await fetch(`${baseUrl()}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/craft_session=[^;]+/);
  expect(match).not.toBeNull();
  return match![0];
}

/**
 * Send a raw WS upgrade request to the host listener and collect everything
 * written back until the socket closes (or `idleMs` passes with data in hand).
 */
function rawUpgrade(headers: string[], idleMs = 300): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    let buf = '';
    let idle: ReturnType<typeof setTimeout> | undefined;
    const done = () => { sock.destroy(); resolve(buf); };
    sock.on('connect', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: c21va2UtdGVzdA==\r\nSec-WebSocket-Version: 13\r\n' +
        headers.map((h) => `${h}\r\n`).join('') + '\r\n',
      );
    });
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      if (idle) clearTimeout(idle);
      idle = setTimeout(done, idleMs);
    });
    sock.on('close', done);
    sock.on('error', () => done());
    setTimeout(done, 3000).unref?.();
    void reject;
  });
}

beforeAll(async () => {
  // Minimal static WebUI dist — just enough for the routes the suite touches.
  webuiDir = mkdtempSync(join(tmpdir(), 'webui-smoke-'));
  writeFileSync(join(webuiDir, 'login.html'), '<!doctype html><title>SMOKE_LOGIN</title>');
  writeFileSync(join(webuiDir, 'index.html'), '<!doctype html><title>SMOKE_INDEX</title>');

  // Fake loopback "RPC" listener the /ws proxy splices to: record what arrives,
  // echo a marker back so the reverse leg of the splice is observable.
  rpcTarget = createNetServer((sock: Socket) => {
    sock.once('data', (buf: Buffer) => {
      rpcReceived = buf.toString('utf8');
      // End after replying so the splice tears down and the client observes a
      // close (keeps the raw-upgrade tests from waiting on their timeout).
      sock.end('RPC_TARGET_ECHO');
    });
  });
  rpcPort = await new Promise<number>((resolve) => {
    rpcTarget.listen(0, '127.0.0.1', () => {
      const addr = rpcTarget.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });

  handler = createWebUiHandler({
    webuiDir,
    secret: SECRET,
    getPassword: () => PASSWORD,
    getWsEndpoint: () => ({ port: rpcPort, protocol: 'ws' }),
    getActiveWorkspaceId: () => 'smoke-workspace',
  });

  // Same wiring the supervisor uses: cookie auth via the shared validateSession,
  // splice target = the loopback RPC endpoint.
  host = createWebUiHost(handler.fetch, {
    validateCookie: async (cookieHeader) => (await validateSession(cookieHeader, SECRET)) !== null,
    getWsTarget: () => ({ port: rpcPort }),
  });
  port = await host.listen('127.0.0.1', 0);
});

afterAll(async () => {
  handler?.dispose();
  await host?.close();
  rpcTarget?.close();
  rmSync(webuiDir, { recursive: true, force: true });
});

describe('WebUI headless smoke — real listener over TCP', () => {
  test('startup: host binds an ephemeral port and /health carries the fork fingerprint', async () => {
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`${baseUrl()}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', fork: 'webui' });
  });

  test('unauthenticated GET / redirects to /login (LEARNING-026 regression)', async () => {
    const res = await fetch(`${baseUrl()}/`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  test('GET /login serves the login page without auth', async () => {
    const res = await fetch(`${baseUrl()}/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SMOKE_LOGIN');
  });

  test('POST /api/auth rejects a wrong password with 401 and no cookie', async () => {
    const res = await fetch(`${baseUrl()}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('POST /api/auth accepts the password and issues a craft_session cookie', async () => {
    const cookie = await login();
    expect(cookie.startsWith('craft_session=')).toBe(true);
    // The issued cookie validates with the same shared validateSession the
    // host's WS-upgrade auth uses (auth holds at both hops).
    expect(await validateSession(cookie, SECRET)).not.toBeNull();
  });

  test('GET /api/config without a cookie is 401', async () => {
    const res = await fetch(`${baseUrl()}/api/config`);
    expect(res.status).toBe(401);
  });

  test('GET /api/config with the cookie returns the single-port /ws proxy URL', async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl()}/api/config`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wsUrl: string };
    expect(body.wsUrl).toBe(`ws://127.0.0.1:${port}/ws`);
  });

  test('GET /api/config/workspaces with the cookie returns the active workspace', async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl()}/api/config/workspaces`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultWorkspaceId: 'smoke-workspace' });
  });

  test('WS upgrade without a cookie is refused and never reaches the RPC target', async () => {
    rpcReceived = '';
    // The host writes `401` then destroys; bun drops upgrade-socket writes
    // (LEARNING-038) so the observable signal here is: connection closed AND
    // the RPC target never saw a byte.
    await rawUpgrade([]);
    expect(rpcReceived).toBe('');
  });

  test('WS upgrade with the login cookie splices the request through to the RPC target', async () => {
    rpcReceived = '';
    const cookie = await login();
    await rawUpgrade([`Cookie: ${cookie}`]);
    // Forward leg through the REAL listener: the replayed upgrade (request
    // line + auth cookie, header names lowercased by bun's node:http) reached
    // the loopback target. Reverse leg is asserted in host.test.ts.
    expect(rpcReceived).toContain('GET /ws HTTP/1.1');
    expect(rpcReceived.toLowerCase()).toContain(`cookie: ${cookie.toLowerCase()}`);
  });
});
