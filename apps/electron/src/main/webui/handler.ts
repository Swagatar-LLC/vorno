/**
 * fork(PLAN-020): Node-portable desktop WebUI fetch handler.
 *
 * A `(Request) => Promise<Response>` handler reimplementing the small route
 * surface of `packages/server-core/src/webui/http-server.ts` WITHOUT Bun APIs
 * (upstream uses `Bun.file` for static serving and `Bun.password`/argon2 for
 * password hashing — neither exists in the Electron main process, which is
 * plain Node). Instead this uses `node:fs`/`node:fs/promises` for static files
 * and `node:crypto` (scrypt + timingSafeEqual) for password verification, while
 * reusing the portable upstream primitives via the server-core/webui barrel:
 * `createSessionToken`, `buildSessionCookie`, `buildLogoutCookie`,
 * `RateLimiter`, `resolveWebSocketUrl`, `validateSession`.
 *
 * The cookie name / JWT shape are upstream's, so the same `validateSession`
 * works on both the HTTP side here and the WS-upgrade side in the in-process
 * WsRpcServer (Q1).
 *
 * Routes:
 *   GET  /health                       (no auth) — fork fingerprint for the supervisor probe
 *   GET  /login, /login/               (no auth)
 *   GET  /favicon.ico, /login-assets/* (no auth)
 *   POST /api/auth                     scrypt verify + RateLimiter(5/60s) → JWT cookie
 *   POST /api/auth/logout              clear cookie
 *   GET  /api/config                   (cookie-gated) → { wsUrl }
 *   GET  /api/config/workspaces        (cookie-gated) → { defaultWorkspaceId }
 *   *    static file + SPA index.html fallback (cookie-gated), path-traversal guarded
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import {
  createSessionToken,
  buildSessionCookie,
  buildLogoutCookie,
  validateSession,
  resolveWebSocketUrl,
  RateLimiter,
} from '@craft-agent/server-core/webui';

// ---------------------------------------------------------------------------
// MIME types (mirrors upstream http-server.ts)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.map': 'application/json',
};

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt — Node-portable replacement for Bun's argon2)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

/**
 * Verify a plaintext password against the persisted plaintext WebUI password
 * using a constant-time comparison over derived scrypt keys. Both inputs are
 * hashed with the same fixed salt (the stored password itself is the secret at
 * rest; scrypt+timingSafeEqual here is defense against timing side-channels on
 * the compare, matching upstream's constant-time verify intent).
 */
function verifyPasswordConstantTime(input: string, expected: string): boolean {
  // Fixed salt: we are comparing two known plaintexts in constant time, not
  // storing a hash — the salt only needs to be stable across the two derivations.
  const salt = Buffer.from('craft-webui-scrypt-v1');
  const a = scryptSync(input, salt, SCRYPT_KEYLEN);
  const b = scryptSync(expected, salt, SCRYPT_KEYLEN);
  // a and b are always equal length (SCRYPT_KEYLEN) so timingSafeEqual is safe.
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Static serving with explicit path-traversal guard
// ---------------------------------------------------------------------------

/**
 * Resolve `urlPath` against `webuiDir` and refuse to serve anything that
 * escapes the directory (upstream relied on Bun.file(join(...)) semantics; the
 * Node port makes the guard explicit). Returns null if traversal is detected.
 */
export function resolveStaticPath(webuiDir: string, urlPath: string): string | null {
  const base = resolve(webuiDir);
  // Decode + strip the leading slash so join treats it as relative.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, '');
  const candidate = resolve(base, rel);
  // Must be the base itself or a descendant of base + separator.
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    return null;
  }
  return candidate;
}

async function serveFile(absPath: string, contentType: string): Promise<Response> {
  const buf = await readFile(absPath);
  return new Response(new Uint8Array(buf), {
    headers: { 'Content-Type': contentType },
  });
}

// ---------------------------------------------------------------------------
// Handler options + factory
// ---------------------------------------------------------------------------

export interface WebUiHandlerOptions {
  /** Path to the built WebUI dist/ directory. */
  webuiDir: string;
  /** Per-app-run JWT signing secret (crypto.randomUUID, in-memory only). */
  secret: string;
  /** Returns the current WebUI login password (may change via regenerate). */
  getPassword: () => string | null;
  /** Returns the live in-process RPC WS endpoint, or undefined when unavailable. */
  getWsEndpoint: () => { port: number; protocol: 'ws' | 'wss' } | undefined;
  /** Returns the active workspace id (mirrors upstream getActiveWorkspace). */
  getActiveWorkspaceId?: () => string | null;
  /** Logger. */
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
}

export interface WebUiHandler {
  fetch: (req: Request) => Promise<Response>;
  dispose: () => void;
}

export function createWebUiHandler(options: WebUiHandlerOptions): WebUiHandler {
  const { webuiDir, secret, getPassword, getWsEndpoint, getActiveWorkspaceId, log } = options;
  const logger = log ?? { info: () => {}, warn: () => {}, error: () => {} };

  const rateLimiter = new RateLimiter(5, 60_000);
  const cleanupTimer = setInterval(() => rateLimiter.cleanup(), 120_000);
  // Do not keep the process alive just for the cleanup timer (parity with app lifecycle).
  (cleanupTimer as unknown as { unref?: () => void }).unref?.();

  // Last-resort guard: a throw from the route logic would otherwise surface
  // only via the node-adapter's console.error, which packaged builds discard
  // (LEARNING-026) — catch here so faults reach the supervisor's mainLog.
  async function fetch(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      logger.error(`[webui] request handler error (${req.method} ${new URL(req.url).pathname})`, err);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Health (no auth) — carries the fork fingerprint the supervisor probes. ──
    if (path === '/health') {
      return Response.json({ status: 'ok', fork: 'webui' });
    }

    // ── Login page (no auth) ──
    if (path === '/login' || path === '/login/') {
      const loginPath = join(webuiDir, 'login.html');
      if (existsSync(loginPath)) {
        return serveFile(loginPath, 'text/html; charset=utf-8');
      }
      return new Response('Login page not found', { status: 404 });
    }

    // ── Login-page static assets (no auth) ──
    if (path === '/favicon.ico' || path.startsWith('/login-assets/')) {
      const abs = resolveStaticPath(webuiDir, path);
      if (abs && existsSync(abs)) {
        return serveFile(abs, getMimeType(path));
      }
      return new Response('Not Found', { status: 404 });
    }

    // ── Auth (POST) — scrypt verify + rate limit → issue JWT cookie ──
    if (path === '/api/auth' && req.method === 'POST') {
      // Loopback-only listener: a single rate-limit bucket ('direct') mirrors
      // upstream desktop semantics (no trusted proxy configured).
      if (!rateLimiter.check('direct')) {
        logger.warn('[webui] rate-limited auth attempt');
        return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
      }

      let body: { password?: string };
      try {
        body = (await req.json()) as { password?: string };
      } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 });
      }
      if (!body.password || typeof body.password !== 'string') {
        return Response.json({ error: 'Password is required' }, { status: 400 });
      }

      const expected = getPassword();
      if (!expected || !verifyPasswordConstantTime(body.password, expected)) {
        logger.warn('[webui] failed auth attempt');
        return Response.json({ error: 'Invalid credentials' }, { status: 401 });
      }

      const jwt = await createSessionToken(secret);
      logger.info('[webui] successful auth');
      return Response.json(
        { ok: true },
        {
          status: 200,
          // Loopback default → no Secure flag (http). Proxied https is out of scope (Q non-goal).
          headers: { 'Set-Cookie': buildSessionCookie(jwt, false) },
        },
      );
    }

    // ── Logout (POST) ──
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': buildLogoutCookie(false) },
      });
    }

    // ── Config (cookie-gated) → wsUrl for the live in-process RPC server ──
    if (path === '/api/config' && req.method === 'GET') {
      const session = await validateSession(req.headers.get('cookie'), secret);
      if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

      const endpoint = getWsEndpoint();
      if (!endpoint) {
        return Response.json({ error: 'RPC server unavailable' }, { status: 503 });
      }
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { wsProtocol: endpoint.protocol, wsPort: endpoint.port }),
      });
    }

    // ── Default workspace (cookie-gated) ──
    if (path === '/api/config/workspaces' && req.method === 'GET') {
      const session = await validateSession(req.headers.get('cookie'), secret);
      if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      return Response.json({ defaultWorkspaceId: getActiveWorkspaceId?.() ?? null });
    }

    // ── Everything below requires a valid session cookie ──
    const session = await validateSession(req.headers.get('cookie'), secret);
    if (!session) {
      const accept = req.headers.get('accept') ?? '';
      if (accept.includes('text/html') || path === '/' || path === '') {
        // NOT Response.redirect('/login'): undici (Electron main = Node) throws
        // on relative URLs — only Bun accepts them, so `bun test` can't catch a
        // regression here and every unauthenticated GET / became a 500 in the
        // packaged app (LEARNING-026). Build the 302 explicitly.
        return new Response(null, { status: 302, headers: { Location: '/login' } });
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Static SPA files (path-traversal guarded) ──
    if (path !== '/') {
      const abs = resolveStaticPath(webuiDir, path);
      if (abs && existsSync(abs)) {
        return serveFile(abs, getMimeType(path));
      }
    }

    // ── SPA fallback — index.html for all non-file routes ──
    const indexPath = join(webuiDir, 'index.html');
    if (existsSync(indexPath)) {
      return serveFile(indexPath, 'text/html; charset=utf-8');
    }

    return new Response('Not Found', { status: 404 });
  }

  return {
    fetch,
    dispose: () => clearInterval(cleanupTimer),
  };
}
