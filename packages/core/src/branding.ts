/**
 * Centralized branding — single source of truth for every user-visible brand
 * string and external endpoint (VOR-3).
 *
 * THE REBRAND IS A ONE-MODULE FLIP: change values here (plus the static files
 * listed in scripts/branding-allowlist.json with reason "sync-with-branding")
 * and the whole app rebrands. Do NOT hardcode "Craft", "craft.do" URLs, or
 * bundle IDs elsewhere — the CI branding gate (scripts/check-branding.ts)
 * fails the build on non-allowlisted occurrences.
 *
 * Wire-protocol identifiers (`craft-fork:*` channels, `craft_sk_*` key
 * prefixes, `__craftRpcType`, `~/.craft-agent` migration-source path,
 * MessageEnvelope fields) are NOT branding — they are compatibility contracts
 * per roadmap/upstream/compatibility.md and must not route through this module.
 *
 * NOTE: the macOS appId is a deliberate exception. ADR-0009 flips it from
 * `com.lukilabs.craft-agent` to `co.swagatar.vorno` (a clean break: the first
 * Vorno build is a fresh /Applications install, not an in-place update). The
 * appId lives in apps/electron/electron-builder.yml, not this module.
 */

/** Product name (plural form used in app title, menus, installers). */
export const PRODUCT_NAME = 'Vorno';

/** Singular product name (agent self-identity, notifications, error text). */
export const PRODUCT_NAME_SINGULAR = 'Vorno';

/** Bare brand name (OAuth callback page title prefix). */
export const BRAND_NAME = 'Vorno';

/** Fork qualifier — the visible "FORK" distinction stays on (see CLAUDE.md). */
export const FORK_QUALIFIER = 'Swagatar Fork';

/**
 * Main window title. The FORK distinction now lives in the accent stripe
 * (fork-badge.tsx), so the title is the bare product name — no parenthetical.
 */
export const WINDOW_TITLE = PRODUCT_NAME;

/** Display name for the built-in Pi backend ("Vorno Backend"). */
export const BACKEND_DISPLAY_NAME = `${PRODUCT_NAME} Backend`;

/** Publisher metadata (installers, package manifests). */
export const COMPANY_NAME = 'Swagatar LLC';
export const SUPPORT_EMAIL = 'support@swagatar.co';

/** Git co-author trailer identity injected into the system prompt. */
export const GIT_COAUTHOR_EMAIL = 'agents-noreply@swagatar.co';
export const GIT_COAUTHOR = `${PRODUCT_NAME_SINGULAR} <${GIT_COAUTHOR_EMAIL}>`;

/**
 * OAuth dynamic-client-registration name sent to MCP authorization servers.
 * Some servers gate behavior on this value — flip with care.
 */
export const OAUTH_CLIENT_NAME = `Claude Code (${PRODUCT_NAME_SINGULAR})`;

// ---------------------------------------------------------------------------
// External endpoints — the self-bricking failure class. A rebrand that misses
// one of these points users' auto-update / OAuth / docs at upstream infra.
// ---------------------------------------------------------------------------

/**
 * Base URL for the **upstream-hosted** service the fork still rides: the OAuth relay.
 *
 * NOTE: the update feed is not derived from this (see UPDATE_MANIFEST_BASE_URL,
 * ADR-0009), nor are the docs (DOCS_URL, ADR-0023), nor session sharing any more
 * (VIEWER_URL, ADR-0024).
 *
 * Kept pointing at upstream infra on purpose. The redirect URIs below are registered
 * with OAuth providers, so flipping them breaks source auth until every provider app
 * is re-registered. That migration is its own decision with its own cost — do not fold
 * it into an unrelated change. When it lands, this constant can be deleted outright.
 */
export const SERVICE_BASE_URL = 'https://agents.craft.do';

/**
 * Session viewer + shared-session API base URL.
 *
 * DECOUPLED from SERVICE_BASE_URL (ADR-0024): Vorno hosts its own shared sessions.
 * Backed by the `vorno-share` Worker and an R2 bucket on the Swagatar account; the
 * Worker and the viewer SPA it serves both live in `apps/viewer`.
 *
 * Its own origin, deliberately — unlike docs, a share is untrusted content submitted
 * by anyone who can reach an unauthenticated POST endpoint, and that does not belong
 * on the apex alongside the marketing site.
 *
 * This constant is used only to CREATE a share. Updating and revoking an *existing*
 * share resolves its origin from the share's own stored URL — see
 * `packages/server-core/src/sessions/share-target.ts`. Shares created before this
 * flip live on upstream's infrastructure and must stay revocable there.
 */
export const VIEWER_URL = 'https://share.vorno.ai';

/** In-app documentation links. */
export const DOCS_URL = `${SERVICE_BASE_URL}/docs`;
export const DOCS_MCP_URL = `${DOCS_URL}/mcp`;
export const DOCS_SHARING_URL = `${DOCS_URL}/go-further/sharing`;

/**
 * "Download the latest release" link for the Vorno fork.
 *
 * DECOUPLED from SERVICE_BASE_URL (ADR-0009): the fork ships via electron-updater's
 * github provider against the public Swagatar-LLC/vorno-releases feed, not the
 * upstream /electron generic feed. This constant is now the user-facing
 * "get the newest build" URL (the GitHub "latest release" page), NOT a
 * generic-provider manifest endpoint. The in-app auto-updater reads the github
 * feed directly (electron-builder.yml `publish:`); it does not consume this URL.
 */
export const UPDATE_MANIFEST_BASE_URL =
  'https://github.com/Swagatar-LLC/vorno-releases/releases/latest';

/**
 * OAuth relay endpoints. WARNING: these redirect URIs are registered with
 * OAuth providers (Google, Slack, ...). Flipping them requires re-registering
 * every provider app — see packages/shared/CLAUDE.md (WebUI source OAuth).
 */
export const OAUTH_RELAY_CALLBACK_URL = `${SERVICE_BASE_URL}/auth/callback`;
export const SLACK_OAUTH_RELAY_CALLBACK_URL = `${SERVICE_BASE_URL}/auth/slack/callback`;

// ---------------------------------------------------------------------------
// Logo assets
// ---------------------------------------------------------------------------

/** ASCII logo used by OAuth callback pages. */
export const VORNO_LOGO = [
  '██      ██   ██████   ████████   ██      ██   ██████',
  '██      ██ ██      ██ ██      ██ ████    ██ ██      ██',
  '██      ██ ██      ██ ████████   ██  ██  ██ ██      ██',
  '  ██  ██   ██      ██ ██    ██   ██    ████ ██      ██',
  '    ██       ██████   ██      ██ ██      ██   ██████',
] as const;

/** Logo as a single string for HTML templates */
export const VORNO_LOGO_HTML = VORNO_LOGO.map((line) => line.trimEnd()).join('\n');
