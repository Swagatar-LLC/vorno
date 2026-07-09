/** Canonical config filename */
export const AUTOMATIONS_CONFIG_FILE = 'automations.json';

/** History log filename */
export const AUTOMATIONS_HISTORY_FILE = 'automations-history.jsonl';

/** Persistent retry queue filename */
export const AUTOMATIONS_RETRY_QUEUE_FILE = 'automations-retry-queue.jsonl';

// ============================================================================
// fork(PLAN-014): webhook ingest
// ============================================================================

/** Per-workspace idempotency store (JSONL, TTL-compacted). */
export const WEBHOOKS_DEDUP_FILE = 'webhooks-dedup.jsonl';

/** Per-workspace durable ingest queue (JSONL, append + tombstone). */
export const WEBHOOKS_INGEST_FILE = 'webhooks-ingest.jsonl';

/** Per-workspace staging dir for raw webhook payload files. */
export const WEBHOOKS_PAYLOADS_DIR = 'webhooks-payloads';

/** Default token prefix for minted hook endpoint tokens. */
export const WEBHOOK_TOKEN_PREFIX = 'craft_whk_';

/** Default inbound body cap (256 KB). */
export const WEBHOOK_DEFAULT_BODY_CAP_BYTES = 256 * 1024;

/** Idempotency retention window (24 h). */
export const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

/** Default per-hook rate limit (requests/minute) when a hook omits its own. */
export const WEBHOOK_DEFAULT_RATE_PER_MINUTE = 60;

/** Default HTTP method for webhook actions */
export const DEFAULT_WEBHOOK_METHOD = 'POST';

/** Maximum length for string fields written to automations-history.jsonl (error, responseBody, prompt). */
export const HISTORY_FIELD_MAX_LENGTH = 2000;

/** Max history entries retained per automation ID. */
export const AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER = 20;

/** Max total history entries across all automations (global safety cap). */
export const AUTOMATION_HISTORY_MAX_ENTRIES = 1000;
