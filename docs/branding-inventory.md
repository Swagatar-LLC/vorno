# Branding inventory (VOR-3)

Audit of every user-visible "Craft" brand string, `craft.do` endpoint, bundle
identifier, and update endpoint across `apps/electron`, `apps/webui`,
`apps/viewer`, `apps/cli`, `apps/server`, `packages/core`, `packages/shared`,
`packages/ui`, `packages/session-tools-core`, `packages/session-mcp-server`
(audited 2026-07-03, fork of upstream v0.10.5).

**This ticket changed no values.** Every constant keeps its current value; the
change is pure indirection plus CI enforcement. The rebrand itself is a
follow-up flip ticket, blocked on VOR-1 trademark clearance.

## The branding module

- Canonical: [`packages/core/src/branding.ts`](../packages/core/src/branding.ts)
  (lives in `core` because `apps/viewer` and `packages/ui` consumers don't all
  depend on `shared`)
- Re-export for general use: [`packages/shared/src/branding.ts`](../packages/shared/src/branding.ts)
  → import from `@craft-agent/shared/branding` (or `../branding.ts` inside
  `packages/shared`); `apps/viewer` imports `@craft-agent/core/branding`.

## Enforcement

- Gate: [`scripts/check-branding.ts`](../scripts/check-branding.ts), run as the
  `branding` job in `.github/workflows/validate-pr.yml` and locally via
  `bun run lint:branding`.
- Rules: `Craft Agent(s)` (case-sensitive), `craft.do` (case-insensitive),
  `lukilabs` / `luki labs` (case-insensitive). Bare `Craft` is deliberately not
  gated — it legitimately refers to the external Craft docs product (sources,
  `mcp.craft.do` validation) and to identifiers.
- Heuristics: comment lines and trailing `//` comments are skipped (comments
  are not user-visible); test files (`*.test.*`, `__tests__/`) are skipped.
- Allowlist: [`scripts/branding-allowlist.json`](../scripts/branding-allowlist.json)
  — a reviewed file; every entry carries a class and reason. The gate warns on
  stale entries.

## Class (a) — user-visible, routed through the branding module

All refactored in VOR-3; values unchanged. ~70 occurrences across 33 files.

| Surface | What | Constant |
|---|---|---|
| electron main | `app.setName`, window title, macOS app-menu label | `PRODUCT_NAME`, `WINDOW_TITLE` |
| electron main/renderer | Help/docs links (`agents.craft.do/docs`, `/docs/go-further/sharing`) | `DOCS_URL`, `DOCS_SHARING_URL` |
| electron renderer | notification fallback, remote-workspace copy | `PRODUCT_NAME_SINGULAR` |
| electron renderer | "Craft Agents Backend" provider/model-picker/settings labels (7 files) | `BACKEND_DISPLAY_NAME` |
| viewer | header logo link + tooltip | `VIEWER_URL`, `PRODUCT_NAME_SINGULAR` (via `@craft-agent/core/branding`) |
| server | startup/disabled console banners | `PRODUCT_NAME` |
| cli | `--help` banner | `PRODUCT_NAME_SINGULAR` |
| shared prompts | system-prompt identity ("You are Craft Agent…", "refer to yourself as…"), CLI section, git co-author trailer | `PRODUCT_NAME_SINGULAR`, `BRAND_NAME`, `GIT_COAUTHOR` |
| shared agent | backend names, error messages ("Reinstalling Craft Agents…", tool-support errors), diagnostics | `BACKEND_DISPLAY_NAME`, `PRODUCT_NAME`, `PRODUCT_NAME_SINGULAR` |
| shared auth | OAuth callback page title/link, dynamic-client-registration name | `BRAND_NAME`, `PRODUCT_NAME`, `OAUTH_CLIENT_NAME` |
| shared auth | OAuth relay redirect URIs (`agents.craft.do/auth/callback`, `/auth/slack/callback`) | `OAUTH_RELAY_CALLBACK_URL`, `SLACK_OAUTH_RELAY_CALLBACK_URL` ⚠ registered with providers — flip requires re-registration |
| shared version | auto-update manifest base (`agents.craft.do/electron`) | `UPDATE_MANIFEST_BASE_URL` |
| shared docs/sources | doc-links base, built-in docs source name/URL/tagline | `DOCS_URL`, `DOCS_MCP_URL`, `PRODUCT_NAME` |
| shared config | model descriptors ("… via Craft Agents Backend"), config-defaults description | `BACKEND_DISPLAY_NAME`, `PRODUCT_NAME` |
| shared interceptor | blocked-request user messages | `PRODUCT_NAME` |
| session-mcp-server | docs proxy URL + user-visible messages | `DOCS_MCP_URL`, `PRODUCT_NAME` |

### Class (a), deferred to the flip ticket (`flip-deferred` / `flip-sync` in the allowlist)

These are class (a) by nature but cannot import a TS module; the flip ticket
must sweep them in the same PR that changes `branding.ts` values:

- **i18n locale values** (`packages/shared/src/i18n/locales/*.json`) — ~29 keys
  per locale contain the brand ("Welcome to Craft Agents", menu items, …).
  Mechanical sweep, guarded by `lint:i18n:parity` / `coverage`.
- **Static shells**: `apps/electron/src/renderer/index.html`,
  `apps/webui/src/index.html` + `login.html` + `public/manifest.json`,
  `apps/viewer/index.html`.
- **Package metadata**: `package.json` descriptions/author for electron,
  server, cli, viewer, core, shared, ui.
- **`apps/electron/electron-builder.yml`**: `productName`, copyright,
  maintainer, artifact names, and the auto-update `publish` URL — the publish
  URL **must stay equal to `UPDATE_MANIFEST_BASE_URL`**.
- **`apps/electron/scripts/afterPack.cjs`**: packaged `.app` path derived from
  `productName`.
- **`packages/session-tools-core`** (3 LLM-visible tool descriptions) —
  dependency-free package; adding a workspace edge to `core` would add weekly
  upstream-merge friction for three strings.

## Class (b) — wire-protocol / internal contracts (must NOT change)

Allowlisted implicitly (they don't match gate rules) or by entry; see
[`roadmap/upstream/compatibility.md`](../roadmap/upstream/compatibility.md).

| Identifier | Where | Why it stays |
|---|---|---|
| `com.lukilabs.craft-agent` appId | `apps/electron/electron-builder.yml` | Bundle ID — changing breaks auto-update, keychain, userData paths. Sequenced with VOR-2 migration, not the flip ticket. |
| `craft_sk_*` API-key prefix | `apps/server/src/config.ts`, `middleware/auth.ts` | Our own key-format contract (compatibility.md). |
| `craft-fork:*` channel namespace | protocol docs | Reserved fork namespace per ADR-0001. |
| `__craftRpcType` | shared codec | Upstream binary-encoding contract. |
| `~/.craft-agent` config dir | `packages/shared/src/config/paths.ts` + consumers | Existing installs' data lives there; migration is its own ticket. |
| `CraftAgent` / `CraftAgentConfig` aliases | `packages/shared/src/agent/claude-agent.ts` | Backward-compat exports for external consumers. |
| `craft-agent-session`, `craft-agent-session-proxy` | `packages/session-mcp-server/src/index.ts` | MCP handshake client/server names — protocol-visible. |
| `CRAFT_APP_NAME` env var | `apps/electron/src/main/index.ts` | Multi-instance dev hook; internal identifier. |
| OAuth relay redirect URIs | branding module (with warning comment) | Values are wire-registered with OAuth providers; centralized but flip requires provider re-registration. |

## Class (c) — upstream internals / dev tooling / external product references

Allowlisted by path (see `scripts/branding-allowlist.json`) or excluded by scan
scope:

- `packages/server-core`, `packages/server`, `packages/messaging-*`,
  `packages/pi-agent-server` — upstream packages, out of ticket scope (not
  scanned).
- `packages/shared/src/validation/url-validator.ts` — validates URLs for the
  **external Craft docs product's** MCP (`mcp.craft.do`); functional rules, not
  our brand.
- `packages/shared/src/docs/source-guides.ts` — maps the external Craft source
  to its domain `craft.do`.
- `apps/electron/resources/` (bundled docs, release notes, config defaults),
  `apps/electron/src/renderer/playground/` + `playground.html` (design-system
  demo data), `apps/viewer/vite.config.ts` (dev proxy),
  `packages/shared/src/prompts/print-system-prompt.ts` (debug script),
  `apps/electron/eslint-rules/no-localstorage.cjs` (lint message).
- Tests and comments — excluded by gate heuristics; not user-visible.
- References to the external **Craft** product as an integration example
  (system prompt "integrate Linear, GitHub, Craft", `Craft source (slug:
  craft)`, "Craft MCP server" errors) — third-party product mentions, kept.

## Counts (audit, 2026-07-03)

| Class | Occurrences | Disposition |
|---|---|---|
| (a) refactored to branding module | ~70 in 33 code files | done in VOR-3 |
| (a) flip-deferred/flip-sync (static files, locales, session-tools-core) | ~29 locale keys ×3 locales + 14 static files | flip ticket |
| (b) wire/internal contracts | 9 identifier families | never change without ADR |
| (c) upstream internals / external-product refs / dev tooling | ~70+ (mostly tests/comments/demo) | allowlisted or out of scope |

## Flip-ticket checklist (draft — blocked on VOR-1)

1. Change values in `packages/core/src/branding.ts`.
2. Sweep every `flip-sync` / `flip-deferred` allowlist entry (the allowlist *is*
   the checklist); shrink the allowlist as files are swept.
3. Locale sweep + `bun run validate:ci`.
4. Re-register OAuth relay redirect URIs with providers (or stand up new relay).
5. Bundle ID / update-feed migration is **VOR-2**, not the flip ticket.
