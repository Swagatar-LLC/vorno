/**
 * fork(VOR-48): GET / and GET /index.html — friendly, unauthenticated landing page.
 *
 * Before this route existed, hitting the server root in a browser returned a raw
 * `{"error":"Missing Authorization header"}` — confusing for anyone who typed the
 * URL to check "is this thing on?". This serves a small, dependency-free HTML page
 * that answers exactly that: server name, version, running status, and how to
 * actually authenticate against /api/*.
 *
 * Registered BEFORE the auth gate (like /health and /hooks). It is deliberately
 * safe to expose:
 *   - No secrets, no key material, no workspace/session data.
 *   - All /api/* routes remain authenticated (401 JSON) — nothing here changes them.
 *   - Branding-gate-safe: no product-name strings, no upstream endpoints.
 *
 * Inline template string on purpose — the trigger server pulls in no view/templating
 * dependency, and this page must render even in the most stripped-down headless build.
 */

import { SERVER_VERSION } from '../version.ts';
import type { SessionPool } from '../services/session-pool.ts';

/** Non-branded display name for the server (branding gate: no product strings). */
const SERVER_NAME = 'Trigger Server';

/** Escape a value for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * GET / — a human-facing status/landing page.
 *
 * @param request  The incoming request (used only to derive the origin for the
 *                 copy-pasteable curl example — never trusted for anything else).
 * @param pool     The session pool, for the live active-session count.
 */
export function handleRoot(request: Request, pool: SessionPool): Response {
  // Derive the origin the caller actually used, so the curl example is copy-paste
  // ready regardless of host/port binding (localhost vs 0.0.0.0, custom port).
  let origin = 'http://127.0.0.1:3847';
  try {
    origin = new URL(request.url).origin;
  } catch {
    // Keep the sensible default if the URL is somehow unparseable.
  }

  const activeSessions = pool.activeCount;
  const safeOrigin = escapeHtml(origin);
  const safeName = escapeHtml(SERVER_NAME);
  const safeVersion = escapeHtml(SERVER_VERSION);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${safeName}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.55;
    background: #0e0f11;
    color: #e6e7e9;
    display: flex;
    justify-content: center;
    padding: 3rem 1.25rem;
  }
  @media (prefers-color-scheme: light) {
    body { background: #f6f7f8; color: #1b1c1e; }
    .card { background: #ffffff; border-color: #e4e5e7; }
    code, pre { background: #f0f1f3; }
    .muted { color: #5b5e63; }
    .hr { background: #e4e5e7; }
  }
  main { width: 100%; max-width: 640px; }
  .card {
    background: #17181b;
    border: 1px solid #26282c;
    border-radius: 14px;
    padding: 1.75rem 1.9rem;
  }
  h1 { font-size: 1.4rem; margin: 0 0 0.15rem; display: flex; align-items: center; gap: 0.6rem; }
  h2 { font-size: 0.95rem; margin: 1.6rem 0 0.5rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .muted { color: #9a9da3; font-size: 0.9rem; }
  .badge {
    display: inline-flex; align-items: center; gap: 0.4rem;
    font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem;
    border-radius: 999px; background: rgba(52, 199, 89, 0.14); color: #34c759;
  }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: #34c759; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1.25rem; margin: 0.75rem 0 0; font-size: 0.9rem; }
  dt { color: #9a9da3; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; background: #26282c; padding: 0.1rem 0.35rem; border-radius: 5px; }
  pre {
    background: #26282c; border-radius: 9px; padding: 0.9rem 1rem;
    overflow-x: auto; font-size: 0.82rem; margin: 0.4rem 0 0;
  }
  pre code { background: none; padding: 0; }
  .hr { height: 1px; background: #26282c; border: 0; margin: 1.6rem 0; }
  a { color: #4a9eff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  p { margin: 0.5rem 0; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${safeName} <span class="badge"><span class="dot"></span>Running</span></h1>
    <p class="muted">A local HTTP trigger server for driving agent sessions from your own automations.</p>

    <dl>
      <dt>Version</dt><dd>${safeVersion}</dd>
      <dt>Active sessions</dt><dd>${activeSessions}</dd>
      <dt>Health</dt><dd><a href="/health">/health</a></dd>
    </dl>

    <hr class="hr">

    <h2>Authenticating</h2>
    <p>Every <code>/api/*</code> endpoint requires an API key sent as a bearer token.
       Unauthenticated API requests return <code>401</code>.</p>
    <pre><code>curl ${safeOrigin}/api/workspaces \\
  -H "Authorization: Bearer craft_sk_YOUR_KEY_HERE"</code></pre>

    <h2>Where keys come from</h2>
    <p>Open the desktop app and go to <strong>Settings &rarr; Remote Access</strong> to
       start the server, choose its bind address, and create or revoke API keys. Keys are
       shown once at creation time — copy them then.</p>

    <hr class="hr">
    <p class="muted">This page is safe to share: it exposes no keys, sessions, or workspace data.</p>
  </div>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
