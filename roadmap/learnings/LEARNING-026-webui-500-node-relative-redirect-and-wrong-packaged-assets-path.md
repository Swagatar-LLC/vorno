---
id: LEARNING-026
title: Packaged WebUI 500 — Response.redirect(relative) throws in Node (Bun tests pass) + webuiDir pointed at the source resources/ dir
date: 2026-07-14
status: active
component: webui
related-plans: [PLAN-020]
related-decisions: []
---

# LEARNING-026 — Packaged WebUI 500: Node-vs-Bun `Response.redirect` divergence + wrong packaged asset path

## Signal

Opening `http://127.0.0.1:3848` (the PLAN-020 browser WebUI) in the packaged
app renders a plain-text page:

```
Internal Server Error
```

- `GET /` → 500, but `GET /health` → 200 and `GET /index.html` (no cookie) → 401 JSON — so the supervisor/host/auth were all fine; only the redirect branch died.
- `GET /login` → 404 "Login page not found" and `GET /favicon.ico` → 404 — second, independent failure.
- **Nothing in the main log.** First observed on Vorno 0.11.4 installed via auto-update (first real-world exercise of the packaged WebUI, shipped 0.11.2).

## Root cause

Two independent fork bugs, one hiding behind the other, plus a logging gap
that made both silent:

1. **`Response.redirect('/login', 302)` throws in Node but not Bun.**
   `apps/electron/src/main/webui/handler.ts` (the Node port of upstream's
   Bun-run `http-server.ts`) kept upstream's relative redirect. Per WHATWG
   spec, `Response.redirect(url)` parses `url` with **no base URL** — Node's
   undici enforces this and throws `TypeError: Failed to parse URL from
   /login`; **Bun accepts relative URLs**. The handler tests run under
   `bun test`, so the existing "redirects to /login" test passed while the
   Electron main process (Node) threw on every unauthenticated `GET /`.
   The node-adapter's catch-all converted the throw into the 500.

   ```bash
   node -e "Response.redirect('/login', 302)"   # TypeError: Failed to parse URL
   bun  -e "Response.redirect('/login', 302)"   # fine
   ```

2. **Packaged `webuiDir` pointed at a directory that never exists.**
   `apps/electron/src/main/index.ts` resolved
   `join(process.resourcesPath, 'app', 'resources', 'webui')` =
   `Resources/app/resources/webui`. But `Resources/app/resources/` is the
   packaged copy of apps/electron's **source** `resources/` dir (bin,
   scripts, MCP servers) — copy-assets stages the webui SPA into
   `dist/resources/webui`, which packages as
   `Resources/app/dist/resources/webui`. The correct runtime resolution is
   `join(__dirname, 'resources', 'webui')` (`__dirname` = the `dist/` dir
   holding `main.cjs` — the same root `setBundledAssetsRoot` uses for
   docs/themes). The wrong-path comment was replicated in copy-assets.ts
   and validate-assets.ts, and `validate-assets` only checks the **staging**
   path (`dist/resources/webui/index.html`), which was correct — so the
   build gate could never catch the runtime-path mismatch.

3. **Both were invisible in the field.** The node-adapter logs handler
   throws via `console.error`, and packaged builds disable the console
   transport (PLAN-015); the supervisor never checked that `webuiDir`
   exists. The supervisor's own lifecycle logs showed a healthy
   `[webui] running on 127.0.0.1:3848` because `/health` doesn't touch
   assets or the redirect branch.

## Fix

PR #85 (branch `jh/2026-07-14_webui-500-fix`):

- `handler.ts`: build the redirect explicitly —
  `new Response(null, { status: 302, headers: { Location: '/login' } })` —
  and wrap the whole route logic in a try/catch that logs through the
  supervisor's logger (→ `~/.craft-agent/logs/main-YYYY-MM-DD.log`) before
  returning a 500.
- `index.ts`: packaged `webuiDir` → `join(__dirname, 'resources', 'webui')`.
- `supervisor.ts`: warn at start when `webuiDir/index.html` is missing (the
  "actionable error at runtime" copy-assets.ts promised but never had).
- Tests: assert exact `Location: /login` and add a curl-style (no Accept
  header) unauthenticated `GET /` case.
- Comments in copy-assets.ts / validate-assets.ts corrected.

Verified by bundling the real handler+host with `bun build --target=node`
and probing under Node: `/` → 302, `/login` → 200, `/health` → 200.

## Recurrence

- **Any Bun-API-compatible code path ported to run in the Electron main
  process (Node).** `bun test` validates Bun semantics, not Node's. Known
  divergences beyond `Response.redirect`: lenient `Response`/`Request`
  parsing, `Bun.file`, argon2 in `Bun.password`. The webui handler was
  ported for exactly this reason and still absorbed one Bun-ism.
- **Any new bundled asset consumed by the main process.** The
  `Resources/app/resources/` (source dir) vs `Resources/app/dist/resources/`
  (staged dir) confusion is easy to re-introduce; the uv/bin block reads the
  former, docs/themes/webui the latter. Sibling failure: LEARNING-017
  (pi-agent-server never staged).

## Prevention

- Handler top-level try/catch means a future handler fault logs the route +
  stack in the main log instead of a bare 500.
- Supervisor warns when the asset dir is missing → wrong-path regressions
  surface on the first start line, not as user-reported 404s/500s.
- When porting Bun server code to the main process, smoke it **under
  `node`** (bundle with `bun build --target=node`, then run with `node`) —
  `bun test` alone proves nothing about undici strictness.
- Runtime asset paths in packaged builds: resolve from `__dirname` (like
  `setBundledAssetsRoot`), never from `process.resourcesPath + 'app' +
  'resources'` unless the file genuinely lives in the source `resources/`
  dir (bin/scripts/MCP servers do; everything copy-assets stages does not).

## References

- PLAN-020 (WebUI bundling), commits 07ad0aa9 / 9705cdf7 / 31d15a06
- LEARNING-017 — sibling packaging/staging failure mode
- LEARNING-015 — why packaged builds have no console transport
- undici `Response.redirect`: requires absolute URL (WHATWG fetch spec §Response.redirect)
