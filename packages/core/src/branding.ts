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
 * prefixes, `__craftRpcType`, `~/.craft-agent` config dir, MessageEnvelope
 * fields, the `com.lukilabs.craft-agent` appId) are NOT branding — they are
 * compatibility contracts per roadmap/upstream/compatibility.md and must not
 * route through this module.
 */

/** Product name (plural form used in app title, menus, installers). */
export const PRODUCT_NAME = 'Craft Agents';

/** Singular product name (agent self-identity, notifications, error text). */
export const PRODUCT_NAME_SINGULAR = 'Craft Agent';

/** Bare brand name (OAuth callback page title prefix). */
export const BRAND_NAME = 'Craft';

/** Fork qualifier — the visible "FORK" distinction stays on (see CLAUDE.md). */
export const FORK_QUALIFIER = 'Swagatar Fork';

/** Main window title. */
export const WINDOW_TITLE = `${PRODUCT_NAME} (${FORK_QUALIFIER})`;

/** Display name for the built-in Pi backend ("Craft Agents Backend"). */
export const BACKEND_DISPLAY_NAME = `${PRODUCT_NAME} Backend`;

/** Publisher metadata (installers, package manifests). */
export const COMPANY_NAME = 'Craft Docs Ltd.';
export const SUPPORT_EMAIL = 'support@craft.do';

/** Git co-author trailer identity injected into the system prompt. */
export const GIT_COAUTHOR_EMAIL = 'agents-noreply@craft.do';
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

/** Base URL for the hosted service (viewer, docs, relay, update feed). */
export const SERVICE_BASE_URL = 'https://agents.craft.do';

/** Session viewer base URL. */
export const VIEWER_URL = SERVICE_BASE_URL;

/** In-app documentation links. */
export const DOCS_URL = `${SERVICE_BASE_URL}/docs`;
export const DOCS_MCP_URL = `${DOCS_URL}/mcp`;
export const DOCS_SHARING_URL = `${DOCS_URL}/go-further/sharing`;

/** Auto-update version manifest base (electron feed lives under /electron). */
export const UPDATE_MANIFEST_BASE_URL = `${SERVICE_BASE_URL}/electron`;

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
export const CRAFT_LOGO = [
  '  ████████ █████████    ██████   ██████████ ██████████',
  '██████████ ██████████ ██████████ █████████  ██████████',
  '██████     ██████████ ██████████ ████████   ██████████',
  '██████████ ████████   ██████████ ███████      ██████  ',
  '  ████████ ████  ████ ████  ████ █████        ██████  ',
] as const;

/** Logo as a single string for HTML templates */
export const CRAFT_LOGO_HTML = CRAFT_LOGO.map((line) => line.trimEnd()).join('\n');
