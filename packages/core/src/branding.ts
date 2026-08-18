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
 * Base URL for the **upstream-hosted** services the fork still rides: the shared-session
 * viewer/API and the OAuth relay. NOTE: the update feed is not derived from this (see
 * UPDATE_MANIFEST_BASE_URL, ADR-0009) and neither are the docs any more (see DOCS_URL,
 * ADR-0023).
 *
 * Kept pointing at upstream infra on purpose. These are registered OAuth relay endpoints
 * and a hosted share backend; flipping them breaks source OAuth and session sharing. That
 * migration is a separate decision with a separate cost — do not fold it into an unrelated
 * change.
 */
export const SERVICE_BASE_URL = 'https://agents.craft.do';

/** Session viewer base URL. Upstream-hosted — see SERVICE_BASE_URL. */
export const VIEWER_URL = SERVICE_BASE_URL;

/**
 * In-app documentation links.
 *
 * DECOUPLED from SERVICE_BASE_URL (ADR-0023): Vorno publishes its own documentation,
 * generated at each release tag from `apps/electron/resources/docs/*.md` and served by
 * the `vorno-site` Worker. Upstream deleted its docs MCP server in v0.12.0 and moved its
 * docs twice in one release; doc discovery no longer depends on a domain we do not own.
 *
 * These pages are a RELEASE ARTIFACT. If the publish step breaks, this constant points at
 * stale or missing pages with no build failure anywhere — the same silent-failure shape as
 * LEARNING-048. The release checklist verifies them over real HTTP for that reason.
 */
export const DOCS_URL = 'https://vorno.ai/docs';
export const DOCS_SHARING_URL = `${DOCS_URL}/sharing`;

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
