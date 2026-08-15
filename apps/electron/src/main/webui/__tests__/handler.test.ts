/**
 * fork(PLAN-020): desktop WebUI handler tests.
 *
 * Exercises the Node-portable fetch handler against a temp webuiDir: auth
 * (scrypt verify, bad-password 401, rate-limit 429 after 5/min), JWT cookie
 * issue → validate via upstream validateSession, config endpoints, static
 * serving + path-traversal guard + SPA fallback.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// CRAFT_CONFIG_DIR is claimed by the bunfig [test] preload before any module
// evaluates. A module-scope assignment here would be dead code — ES imports
// hoist above it (LEARNING-056).

import { createWebUiHandler, resolveStaticPath } from '../handler';
import { validateSession } from '@craft-agent/server-core/webui';

const SECRET = 'test-jwt-secret-uuid';
const PASSWORD = 'correct-horse-battery';

let webuiDir: string;

beforeAll(() => {
  webuiDir = mkdtempSync(join(tmpdir(), 'webui-dir-'));
  writeFileSync(join(webuiDir, 'login.html'), '<!doctype html><title>Login</title>');
  writeFileSync(join(webuiDir, 'index.html'), '<!doctype html><title>App</title>');
  writeFileSync(join(webuiDir, 'app.js'), 'console.log("app")');
  writeFileSync(join(webuiDir, 'favicon.ico'), 'icodata');
  writeFileSync(join(webuiDir, 'favicon.svg'), '<svg/>');
  writeFileSync(join(webuiDir, 'apple-touch-icon.png'), 'pngdata');
  mkdirSync(join(webuiDir, 'login-assets'), { recursive: true });
  writeFileSync(join(webuiDir, 'login-assets', 'login.css'), 'body{}');
  // A "secret" file OUTSIDE webuiDir to prove traversal is blocked.
  writeFileSync(join(webuiDir, '..', 'outside-secret.txt'), 'TOP SECRET');
});

function makeHandler(overrides: Record<string, unknown> = {}) {
  return createWebUiHandler({
    webuiDir,
    secret: SECRET,
    getPassword: () => PASSWORD,
    getWsEndpoint: () => ({ port: 5555, protocol: 'ws' as const }),
    getActiveWorkspaceId: () => 'ws_active_1',
    ...overrides,
  });
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:3848${path}`, init);
}

function extractCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  return setCookie.split(';')[0]; // name=value
}

describe('WebUI handler — health & login (no auth)', () => {
  test('GET /health returns fork fingerprint', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', fork: 'webui' });
    h.dispose();
  });

  test('GET /login serves login.html', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/login'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Login');
    h.dispose();
  });

  test('GET /favicon.ico and /login-assets/* served without auth', async () => {
    const h = makeHandler();
    const fav = await h.fetch(req('/favicon.ico'));
    expect(fav.status).toBe(200);
    const css = await h.fetch(req('/login-assets/login.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    h.dispose();
  });

  test('GET /favicon.svg and /apple-touch-icon.png served without auth (login.html logo)', async () => {
    const h = makeHandler();
    const svg = await h.fetch(req('/favicon.svg'));
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    const touch = await h.fetch(req('/apple-touch-icon.png'));
    expect(touch.status).toBe(200);
    expect(touch.headers.get('content-type')).toContain('image/png');
    h.dispose();
  });
});

describe('WebUI handler — auth', () => {
  test('POST /api/auth with correct password issues a cookie that validates', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    }));
    expect(res.status).toBe(200);
    const cookie = extractCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie!.startsWith('craft_session=')).toBe(true);

    // Round-trip: the issued cookie validates via upstream validateSession.
    const session = await validateSession(cookie, SECRET);
    expect(session).not.toBeNull();
    h.dispose();
  });

  test('POST /api/auth with wrong password → 401 (scrypt verify)', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong' }),
    }));
    expect(res.status).toBe(401);
    expect(extractCookie(res)).toBeNull();
    h.dispose();
  });

  test('POST /api/auth is rate-limited (429) after 5 attempts/min', async () => {
    const h = makeHandler();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await h.fetch(req('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
      }));
      statuses.push(res.status);
    }
    // First 5 allowed (401), 6th rate-limited (429).
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    h.dispose();
  });

  test('POST /api/auth/logout clears the cookie', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/api/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Max-Age=0');
    h.dispose();
  });
});

describe('WebUI handler — config endpoints (cookie-gated)', () => {
  async function authedCookie(h: ReturnType<typeof makeHandler>): Promise<string> {
    const res = await h.fetch(req('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    }));
    return extractCookie(res)!;
  }

  // fork(PLAN-022): /api/config returns the WebUI's OWN origin + /ws proxy path,
  // NOT the loopback RPC port (5555). The single-port proxy splices /ws upgrades
  // to the RPC listener, so remote clients only ever see this one port.
  test('GET /api/config requires cookie → 401 without, proxied /ws url with', async () => {
    const h = makeHandler();
    const unauth = await h.fetch(req('/api/config'));
    expect(unauth.status).toBe(401);

    const cookie = await authedCookie(h);
    const res = await h.fetch(req('/api/config', { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Own origin (request host:port) + /ws — never the RPC port.
    expect(body.wsUrl).toBe('ws://127.0.0.1:3848/ws');
    expect(body.wsUrl).not.toContain('5555');
    h.dispose();
  });

  test('GET /api/config uses the request Host header verbatim (remote LAN IP)', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    // A phone hitting the LAN IP sends Host: 192.168.1.20:3848 — the proxy URL
    // must carry that exact authority so the browser reconnects to the same port.
    const res = await h.fetch(req('/api/config', {
      headers: { cookie, host: '192.168.1.20:3848' },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).wsUrl).toBe('ws://192.168.1.20:3848/ws');
    h.dispose();
  });

  test('GET /api/config upgrades ws→wss behind an https proxy (x-forwarded-proto)', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    // tailscale serve / nginx terminates TLS and forwards these headers.
    const res = await h.fetch(req('/api/config', {
      headers: {
        cookie,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'box.tail1234.ts.net',
      },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).wsUrl).toBe('wss://box.tail1234.ts.net/ws');
    h.dispose();
  });

  test('GET /api/config → 503 when RPC endpoint unavailable', async () => {
    const h = makeHandler({ getWsEndpoint: () => undefined });
    const cookie = await authedCookie(h);
    const res = await h.fetch(req('/api/config', { headers: { cookie } }));
    expect(res.status).toBe(503);
    h.dispose();
  });

  test('GET /api/config/workspaces returns active workspace id', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    const res = await h.fetch(req('/api/config/workspaces', { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect((await res.json()).defaultWorkspaceId).toBe('ws_active_1');
    h.dispose();
  });
});

describe('WebUI handler — static serving, traversal guard, SPA fallback', () => {
  async function authedCookie(h: ReturnType<typeof makeHandler>): Promise<string> {
    const res = await h.fetch(req('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    }));
    return extractCookie(res)!;
  }

  test('unauthenticated HTML request redirects to /login', async () => {
    const h = makeHandler();
    const res = await h.fetch(req('/', { headers: { accept: 'text/html' } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    h.dispose();
  });

  test('unauthenticated GET / without an Accept header also 302s (curl-style)', async () => {
    // Regression (LEARNING-026): this branch used Response.redirect('/login'),
    // which Bun accepts but Node/undici throws on — the packaged app returned
    // 500 for every unauthenticated /. The redirect must be a plain Response.
    const h = makeHandler();
    const res = await h.fetch(req('/'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    h.dispose();
  });

  test('authenticated static file is served with correct MIME', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    const res = await h.fetch(req('/app.js', { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    h.dispose();
  });

  test('authenticated unknown route falls back to index.html (SPA)', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    const res = await h.fetch(req('/some/spa/route', { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('App');
    h.dispose();
  });

  test('path-traversal (../) is blocked', async () => {
    const h = makeHandler();
    const cookie = await authedCookie(h);
    // Encoded + raw traversal attempts must NOT leak the outside-secret file.
    const attempts = ['/../outside-secret.txt', '/..%2foutside-secret.txt', '/%2e%2e/outside-secret.txt'];
    for (const p of attempts) {
      const res = await h.fetch(req(p, { headers: { cookie } }));
      const text = await res.text();
      expect(text).not.toContain('TOP SECRET');
      // Either blocked (SPA fallback to index.html) — never the secret file.
      expect(res.headers.get('content-type')).not.toContain('text/plain');
    }
    h.dispose();
  });

  test('resolveStaticPath rejects escapes, accepts descendants', () => {
    expect(resolveStaticPath(webuiDir, '/app.js')).toBe(join(webuiDir, 'app.js'));
    expect(resolveStaticPath(webuiDir, '/../outside-secret.txt')).toBeNull();
    expect(resolveStaticPath(webuiDir, '/login-assets/login.css')).toBe(join(webuiDir, 'login-assets', 'login.css'));
  });
});
