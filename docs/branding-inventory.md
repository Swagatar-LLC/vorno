# Branding inventory — every location a brand change must touch

Authoritative map of user-visible "**Vorno**" brand strings, external endpoints,
bundle identifiers, and logo assets across `apps/electron`, `apps/webui`,
`apps/viewer`, `apps/cli`, `apps/server`, `packages/core`, `packages/shared`,
`packages/ui`, `packages/session-tools-core`, `packages/session-mcp-server`.

> **Status: the Craft → Vorno flip is DONE.** Executed under
> [ADR-0009](../roadmap/decisions/0009-vorno-rebrand-appid-release-feed-signing.md)
> / PLAN-019 (values flipped in `branding.ts`) and swept across the
> non-module surfaces since. This doc is now the **go-forward reference**: if
> the brand ever changes again, everything listed here must move together in
> one PR. Last full sweep + audit: **2026-07-16**. A top-level docs prose sweep
> (`ARCHITECTURE.md`, `CONTAINER-ARCHITECTURE.md`, and `docs/*.md`) followed on
> **2026-07-17** as part of public-flip prep — see the sweep log below.

## TL;DR — how to rebrand again

1. **Change values in [`packages/core/src/branding.ts`](../packages/core/src/branding.ts).**
   That one module drives ~70 user-visible strings/URLs across 33 code files
   (via `@craft-agent/shared/branding` / `@craft-agent/core/branding`).
2. **Sweep the non-module surfaces below** — they can't import the TS module
   (static HTML, JSON locales, YAML build config, binary icon assets). The
   `sync-with-branding` entries in
   [`scripts/branding-allowlist.json`](../scripts/branding-allowlist.json) are
   the checklist.
3. **Run the gates:** `bun run lint:branding`, `bun run lint:i18n:parity`,
   `bun run lint:i18n:sorted`, `bun run lint:i18n:coverage`, `bun run build`.
4. **Re-register external endpoints** if `SERVICE_BASE_URL` / OAuth relay URIs
   change (they're wire-registered with providers — see the ⚠ rows below).
5. **Bundle ID / update-feed** is a separate one-way door (ADR-0009), not a
   string flip — see class (b).

## The branding module (class a — the one-flip surface)

- Canonical: [`packages/core/src/branding.ts`](../packages/core/src/branding.ts)
  (lives in `core` because `apps/viewer` and `packages/ui` consumers don't all
  depend on `shared`). **All values are currently `Vorno` / Swagatar.**
- Re-export: [`packages/shared/src/branding.ts`](../packages/shared/src/branding.ts)
  → `@craft-agent/shared/branding`; `apps/viewer` imports `@craft-agent/core/branding`.

| Constant | Current value | Drives |
|---|---|---|
| `PRODUCT_NAME` / `PRODUCT_NAME_SINGULAR` / `BRAND_NAME` | `Vorno` | app title, menus, notifications, agent self-identity, error text, OAuth page |
| `BACKEND_DISPLAY_NAME` | `Vorno Backend` | provider / model-picker / settings labels (7 files) |
| `WINDOW_TITLE` | `Vorno` | main window title |
| `COMPANY_NAME` / `SUPPORT_EMAIL` | `Swagatar LLC` / `support@swagatar.co` | installers, manifests |
| `GIT_COAUTHOR` | `Vorno <agents-noreply@swagatar.co>` | system-prompt git trailer |
| `OAUTH_CLIENT_NAME` | `Claude Code (Vorno)` | MCP dynamic-client-registration ⚠ some servers gate on this |
| `SERVICE_BASE_URL` / `DOCS_URL` | `https://agents.craft.do…` | ⚠ **kept on upstream infra** — registered OAuth-relay / docs endpoints; flip requires re-registration |
| `VIEWER_URL` | `https://share.vorno.ai` | Vorno-hosted shares (ADR-0024). Used to **create** only — update/revoke follow the share's own stored URL, so pre-cutover shares stay revocable on upstream |
| `OAUTH_RELAY_CALLBACK_URL` / `SLACK_OAUTH_RELAY_CALLBACK_URL` | `agents.craft.do/auth/*` | ⚠ wire-registered with OAuth providers |
| `UPDATE_MANIFEST_BASE_URL` | `github.com/Swagatar-LLC/vorno-releases/releases/latest` | "get the newest build" link (auto-updater reads the github feed via `electron-builder.yml`) |
| `VORNO_LOGO` / `VORNO_LOGO_HTML` | ASCII "VORNO" | OAuth callback pages |

## Non-module surfaces that must be swept in the same PR (class a, deferred)

These are user-visible but can't import `branding.ts`. **All are currently
Vorno-correct**; listed so a future rebrand sweeps them.

| Surface | File(s) | Notes |
|---|---|---|
| **i18n locale values** | `packages/shared/src/i18n/locales/*.json` (7 locales) | Brand appears in `menu.*`, `onboarding.reauth.*`, welcome, etc. **Key _names_ keep "Craft" (`menu.aboutCraftAgents`, `menu.craftMenu`) by design — not user-visible; only values matter.** Guarded by `lint:i18n:parity` / `:sorted` / `:coverage`. |
| **Electron static shell** | `apps/electron/src/renderer/index.html` (`<title>`) | |
| **WebUI static shells** | `apps/webui/src/index.html`, `login.html`, `public/manifest.json` | login copy aligned to Settings ("Web UI" / "Password"). |
| **WebUI icon assets** | `apps/webui/src/public/{favicon.svg,favicon.ico,apple-touch-icon.png,icon-192.png,icon-512.png}` | PWA / Add-to-Home-Screen icons. Regenerate from `apps/electron/resources/icon.png`. **Binary — not caught by the text gate.** |
| **Viewer static shell** | `apps/viewer/index.html` (`<title>`) | |
| **In-app logo components** | `apps/electron/src/renderer/components/icons/{AppSymbol,AppIcon}.tsx` + `assets/logo_mark.svg` | Redrawn to the Vorno vortex-"V". **Filenames + code identifiers scrubbed brand-neutral 2026-07-18** (`CraftAgentsSymbol`→`AppSymbol`, `CraftAppIcon`→`AppIcon`, `craft_logo_c.svg`→`logo_mark.svg`) per owner decision — see sweep log. `AppWordmark.tsx` (was `CraftAgentsLogo.tsx`, pixel wordmark) is **playground-only** — cosmetic, not in shipped flows. |
| **App / installer icons** | `apps/electron/resources/icon.png`, `icon.svg`, `build/AppIcon.icon/`, `resources/craft-logos/` | macOS app icon, dock, DMG. Binary — not gated. |
| **Package metadata** | `package.json` `description`/`author` for electron, viewer, core, shared, ui | npm-facing. |
| **electron-builder.yml** | `apps/electron/electron-builder.yml` | `productName: Vorno`, copyright, `artifactName: Vorno-${arch}.*`, and `publish:` (= the vorno-releases github feed). |
| **afterPack** | `apps/electron/scripts/afterPack.cjs` | packaged `.app` path derived from `productName`. |
| **session-tools-core** | `packages/session-tools-core/src/…` | 3 LLM-visible tool descriptions; dependency-free package (no workspace edge to `core` — swept by hand). |

## Class (b) — wire / bundle identifiers that must **NOT** change

Compatibility contracts ([`roadmap/upstream/compatibility.md`](../roadmap/upstream/compatibility.md)).
These legitimately keep "craft" and are allowlisted or don't match gate rules.

| Identifier | Where | Why it stays |
|---|---|---|
| `com.lukilabs.craft-agent` → `co.swagatar.vorno` appId | `electron-builder.yml` | appId already flipped (ADR-0009 clean break); a *further* change breaks auto-update/keychain/userData. |
| `craft_sk_*` API-key prefix | `apps/server/src/config.ts`, `middleware/auth.ts` | our key-format contract. |
| `craft-fork:*` channel namespace | `channels.ts` | reserved fork namespace (ADR-0001). |
| `__craftRpcType` | shared codec | upstream binary-encoding contract. |
| `~/.craft-agent` config dir | `packages/shared/src/config/paths.ts` + consumers | existing installs' data; migration is its own ticket. |
| `CraftAgent` / `CraftAgentConfig` aliases | `packages/shared/src/agent/claude-agent.ts` | back-compat exports. |
| `craft-agent-session[-proxy]` MCP names | `packages/session-mcp-server/src/index.ts` | protocol-visible handshake names. |
| `CRAFT_*` env vars (`CRAFT_SERVER_TOKEN`, `CRAFT_APP_NAME`, `CRAFT_LOG_LEVEL`, `CRAFT_RPC_*`, `CRAFT_KEEP_BG_AGENTS_ALIVE`) | various | internal identifiers / dev hooks. |
| `@craft-agent/*` workspace package names | all manifests | internal module graph. |
| `craftagents://` deep-link scheme | ntfy source, deep links | registered URL scheme. |

## Class (c) — legitimate "craft" that is NOT our brand

Kept on purpose (allowlisted by path/entry or excluded by scan scope):

- **The external Craft.do product** referenced as an example integration —
  `editPopover.example.addSource` ("Connect to my Craft space"), the
  `{source:Craft}` example hints, system-prompt "integrate Linear, GitHub,
  Craft", `mcp.craft.do` validator rules, `source-guides.ts` domain map.
  Third-party product mentions.
- **Upstream packages** — `packages/server-core`, `packages/server`,
  `packages/messaging-*`, `packages/pi-agent-server` (their `package.json`
  `description` fields still say "Craft Agent"; left to minimize upstream-merge
  friction — npm metadata, not in-app UX).
- **Dev-only surfaces** — `apps/electron/src/renderer/playground/**` +
  `playground.html` (design-system demo data), viewer `vite.config.ts` dev
  proxy, `print-system-prompt.ts` debug script, eslint rule messages.
- **Code comments & tests** — not user-visible; skipped by gate heuristics.

## Enforcement

- Gate: [`scripts/check-branding.ts`](../scripts/check-branding.ts) → `branding`
  job in [`.github/workflows/validate-pr.yml`](../.github/workflows/validate-pr.yml);
  local: `bun run lint:branding`. Rules: `Craft Agent(s)` (case-sensitive),
  `craft.do`, `lukilabs`/`luki labs`. Bare `Craft` is intentionally **not**
  gated (external product + identifiers). Comments and `*.test.*`/`__tests__/`
  are skipped. **`release/` is gitignored** — a local packaged build will trip
  the gate on bundled upstream/playground copies, but CI (fresh checkout, no
  `release/`) stays clean.
- Allowlist: [`scripts/branding-allowlist.json`](../scripts/branding-allowlist.json)
  — every entry carries a class + reason; the gate warns on stale entries.
- **Binary assets (icons) are not text-scannable** — verify them by eye on a
  rebrand (favicon, apple-touch/PWA icons, app icon, DMG).

## Sweep log

| Date | What | Outcome |
|---|---|---|
| 2026-07-03 | VOR-3 audit | Indirection + gate landed; values unchanged (pre-flip). |
| 2026-07-15 | WebUI shell | `index.html`/`login.html`/`manifest.json` titles + login copy; PWA/apple-touch/favicon icons regenerated from the Vorno mark (were the Craft "C"). |
| 2026-07-16 | Full nook-and-cranny pass | Swept the last user-visible string leaks: `menu.craftMenu`, `onboarding.reauth.expired`, `onboarding.reauth.loginWithCraft` across all 7 locales. Confirmed `branding.ts` = Vorno, all logo components/assets = Vorno, static shells/builder/viewer clean. Remaining "craft" in source is class (b) wire, class (c) external-product/dev-only, code comments, or upstream `package.json` npm descriptions (intentionally deferred). |
| 2026-07-17 | Public-flip prep — top-level docs prose sweep | Swept product-name prose in `ARCHITECTURE.md`, `CONTAINER-ARCHITECTURE.md`, `docs/http-trigger-server.md`, `docs/server-deployment.md`, `docs/webhooks.md`, `docs/webui-remote-access.md` ("Craft Agent(s)" → "Vorno" in titles/prose); wire identifiers (`craft_sk_*`, `craft_whk_*`, `__craftRpcType`, `CRAFT_*` env vars, `~/.craft-agent`, `craft-fork:*`) and upstream repo refs left untouched per class (b)/(c). `docs/cli.md` owned by a separate pass. |
| 2026-07-18 | Public-flip prep — Craft-branded FILENAME scrub (owner decision: drop the brand from asset/component filenames; supersedes the earlier "filenames keep Craft" note) | `git mv` renames: `resources/logos/craft_app_icon{,_dark}.png`→`app_icon{,_dark}.png`, `resources/logos/craft_logo_{black,white}.png`→`logo_{black,white}.png` (dir copied wholesale by `copy-assets.ts`; verified zero code refs to old basenames); `renderer/assets/craft_logo_c.svg`→`logo_mark.svg` (import in `AppIcon.tsx` updated); components `CraftAppIcon.tsx`→`AppIcon.tsx`, `CraftAgentsSymbol.tsx`→`AppSymbol.tsx`, `CraftAgentsLogo.tsx`→`AppWordmark.tsx` with exported identifiers renamed and all 8 importers + playground registry ids (`craft-agents-{logo,symbol}`→`app-{wordmark,symbol}`, playground-only) updated; `resources/tool-icons/craft-agent.svg`→`agent.svg` (renamed the FILE only + updated the `icon` field in `tool-icons.json`; the entry's `id`/`commands` `"craft-agent"` are the runtime command-match keys, not the filename, and were left intact per class (b)). Runtime behavior identical; `bunx tsc --noEmit -p apps/electron` clean. |
