/**
 * Automation System Type Definitions
 *
 * All types, interfaces, and type exports for the automations system.
 */

import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

// ============================================================================
// Event Types
// ============================================================================

/** App events - handled by Craft */
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'SessionStatusChange'
  | 'SchedulerTick'
  // fork(PLAN-014): inbound webhook tick with payload. Emitted on the
  // WorkspaceEventBus by the receiver in `webhook-ingest/`.
  | 'WebhookReceived';

/** Agent events - passed to Claude SDK */
export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup';

export type AutomationEvent = AppEvent | AgentEvent;

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'SessionStatusChange', 'SchedulerTick',
  'WebhookReceived', // fork(PLAN-014)
];

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
];

// ============================================================================
// Action Definitions
// ============================================================================

/** A prompt action - sends a prompt to Craft Agent */
export interface PromptAction {
  type: 'prompt';
  prompt: string;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /**
   * Thinking level for the created session.
   * When omitted, falls back to the workspace default (then DEFAULT_THINKING_LEVEL).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * When true, requests Anthropic fast mode for the spawned session. Logged
   * explicitly in the automation event stream; capability-gated by the model.
   */
  fastMode?: boolean;
}

/** HTTP method for webhook actions */
export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Body format for webhook actions */
export type WebhookBodyFormat = 'json' | 'form' | 'raw';

/** Authentication shorthand for webhook actions */
export type WebhookAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

/** A webhook action - sends an HTTP request to an endpoint */
export interface WebhookAction {
  type: 'webhook';
  /** The URL to send the webhook to (http or https) */
  url: string;
  /** HTTP method (default: POST) */
  method?: WebhookHttpMethod;
  /** HTTP headers as key-value pairs */
  headers?: Record<string, string>;
  /** Body format: 'json' sends Content-Type application/json, 'form' URL-encodes, 'raw' sends as-is */
  bodyFormat?: WebhookBodyFormat;
  /** Request body — JSON object when bodyFormat is 'json' or 'form', string when 'raw' */
  body?: unknown;
  /** Capture response body in result (truncated to 4KB). Default: false */
  captureResponse?: boolean;
  /** Authentication shorthand (applied before custom headers) */
  auth?: WebhookAuth;
}

// ============================================================================
// Session Actions (fork(PLAN-014) — M2 action vocabulary)
// ============================================================================

/**
 * Selects which existing session an action targets. Exactly one of `id` /
 * `label` is used; string values support `$ENV` expansion and `$.jsonpath`
 * extraction from the webhook body (resolved by the handler before delivery).
 */
export interface SessionTargetSelector {
  /** Explicit session id (literal, `$ENV`, or `$.jsonpath` into the payload). */
  id?: string;
  /**
   * A label (or `id::value`). Resolves to the most recently active session
   * carrying that label. Resolution is host-side (needs a workspace scan).
   */
  label?: string;
}

/** Set the status of an existing session. */
export interface SetStatusAction {
  type: 'set-status';
  session: SessionTargetSelector;
  status: string;
  /**
   * When false (default), a closed status (`done`/`cancelled`) is rejected —
   * mirrors the house rule that agents never close tasks. `true` is explicit
   * user intent at registration time.
   */
  allowClosed?: boolean;
}

/** Add and/or remove labels on an existing session. */
export interface SetLabelsAction {
  type: 'set-labels';
  session: SessionTargetSelector;
  /** Labels to add (supports valued `id::value` entries). */
  add?: string[];
  /** Labels to remove. */
  remove?: string[];
}

/** Send a message to an existing session. */
export interface SendMessageAction {
  type: 'send-message';
  session: SessionTargetSelector;
  message: string;
}

/** The three new session-mutation actions. */
export type SessionAction = SetStatusAction | SetLabelsAction | SendMessageAction;

export type AutomationAction =
  | PromptAction
  | WebhookAction
  | SetStatusAction
  | SetLabelsAction
  | SendMessageAction;

// ============================================================================
// Hook Registration (fork(PLAN-014))
// ============================================================================

/** Optional HMAC verification (Phase 2 — parsed & validated in Phase 1, enforced later). */
export interface HookVerification {
  type: 'hmac-sha256';
  /** Env var holding the shared secret (never stored in automations.json). */
  secretEnv: string;
  /** Header carrying the provider signature. */
  signatureHeader: string;
  /** Replay tolerance for signed timestamps, in ms. */
  timestampToleranceMs?: number;
}

/** Where to read the idempotency key from. */
export interface HookIdempotencyKey {
  source: 'header' | 'body';
  /** Header name, or JSONPath-lite expression into the body. */
  name: string;
}

/** Debounce/coalesce config (Phase 2). */
export interface HookDebounce {
  windowMs: number;
  maxWaitMs?: number;
  strategy?: 'trailing' | 'collect';
  debounceKey?: string;
}

/** Per-hook rate limit (Phase 1). */
export interface HookRateLimit {
  perMinute: number;
  burst?: number;
}

/** Per-hook concurrency guard (Phase 2). */
export interface HookConcurrency {
  maxActiveSessions: number;
  overflow?: 'queue' | 'coalesce' | 'drop';
}

/**
 * Hook registration — to `WebhookReceived` what `cron` is to `SchedulerTick`.
 * Lives on the matcher; the endpoint token is hashed at rest.
 */
export interface HookConfig {
  /** URL segment; unique per workspace; `[a-z0-9-]{1,64}`. */
  slug: string;
  /**
   * Capability-URL token, hashed at rest (`sha256:<hex64>`). Optional so a hook
   * can be registered before its token is minted, and so REVOKE(clear) can strip
   * the token — a hook without a `tokenHash` cannot be invoked (the receiver
   * 404s every token). fork(PLAN-014)
   */
  tokenHash?: string;
  /** Display-only token prefix (e.g. `craft_whk_...f3a`). */
  tokenPrefix?: string;
  /** Optional HMAC verification (Phase 2). */
  verification?: HookVerification;
  /** Idempotency key extraction (falls back to body SHA-256 when omitted). */
  idempotencyKey?: HookIdempotencyKey;
  /** Debounce/coalesce (Phase 2). */
  debounce?: HookDebounce;
  /** Per-hook rate limit (Phase 1). */
  rateLimit?: HookRateLimit;
  /** Concurrency guard (Phase 2). */
  concurrency?: HookConcurrency;
  /** Body size cap in bytes (defaults to the receiver default). */
  bodyCapBytes?: number;
}

// ============================================================================
// Condition Types
// ============================================================================

/** Time-of-day and day-of-week condition */
export interface TimeCondition {
  condition: 'time';
  /** Start time in 24h HH:MM format */
  after?: string;
  /** End time in 24h HH:MM format */
  before?: string;
  /** Days of week (3-letter lowercase: mon, tue, wed, thu, fri, sat, sun) */
  weekday?: string[];
  /** IANA timezone (falls back to matcher timezone, then system local) */
  timezone?: string;
}

/** State/field check condition with HA-style from/to for transitions */
export interface StateCondition {
  condition: 'state';
  /** Field name to check (e.g. 'permissionMode', 'sessionStatus', 'labels', 'isFlagged') */
  field: string;
  /** Exact value match */
  value?: unknown;
  /** Transition: previous value (mapped via TRANSITION_FIELDS) */
  from?: unknown;
  /** Transition: new value (mapped via TRANSITION_FIELDS) */
  to?: unknown;
  /** Array membership check */
  contains?: string;
  /** Negation: matches anything except this value */
  not_value?: unknown;
}

/** Logical composition condition (and/or/not) */
export interface LogicalCondition {
  condition: 'and' | 'or' | 'not';
  conditions: AutomationCondition[];
}

/** Union of all condition types */
export type AutomationCondition = TimeCondition | StateCondition | LogicalCondition;

// ============================================================================
// Matcher Definition
// ============================================================================

export interface AutomationMatcher {
  /** Short 6-character hex ID for stable identification across config changes. */
  id?: string;
  /** Optional display name. If omitted, derived from the first action. */
  name?: string;
  /** Regex pattern for matching event data (not used for SchedulerTick) */
  matcher?: string;
  /** Cron expression for SchedulerTick events (5-field format) */
  cron?: string;
  /**
   * fork(PLAN-014): hook registration — required on `WebhookReceived` matchers,
   * rejected on all other events (mirror of the cron↔SchedulerTick rule).
   */
  hook?: HookConfig;
  /**
   * fork(PLAN-014): JSONPath-lite expression selecting the field of the webhook
   * body that `matcher` is tested against (e.g. `$.type`). WebhookReceived only.
   */
  matchField?: string;
  /** IANA timezone for cron evaluation (e.g., "Europe/Budapest", "America/New_York") */
  timezone?: string;
  /** Permission mode for sessions created by prompt actions. */
  permissionMode?: PermissionMode;
  /** Labels to apply to sessions created by prompt actions */
  labels?: string[];
  /** Whether this automation matcher is enabled. Defaults to true. Set to false to disable without removing. */
  enabled?: boolean;
  /** Optional conditions that must all pass (AND) after matcher matches, before actions fire */
  conditions?: AutomationCondition[];
  /**
   * Optional Telegram forum-topic name. When set, sessions spawned by this
   * matcher are bound to a forum topic of this name in the workspace's paired
   * supergroup. The topic is created on first use and reused thereafter.
   * Multiple matchers using the same value share one topic.
   *
   * Silently ignored when:
   *   - No supergroup is paired in Settings → Messaging → Telegram
   *   - The Telegram bot is not connected
   *   - The bot lacks "Manage Topics" permission in the supergroup
   */
  telegramTopic?: string;
  /**
   * fork(PLAN-017): actions to run when a not-ok history record is appended for
   * this matcher — a dispatch failure, an outcome record with `ok:false`, or a
   * missed-fire record. Only `prompt` and `webhook` actions are permitted here
   * (validated in schemas/validation). onFailure runs are never themselves
   * outcome-reconciled and never trigger onFailure (no recursion — the guard is
   * that onFailure prompt sessions carry no `matcherId`).
   */
  onFailure?: (PromptAction | WebhookAction)[];
  actions: AutomationAction[];
}

export interface AutomationsConfig {
  automations: Partial<Record<AutomationEvent, AutomationMatcher[]>>;
}

// ============================================================================
// Action Results
// ============================================================================

/** References parsed from a prompt (@name for sources and skills) */
export interface PromptReferences {
  /**
   * All @name references found in the prompt.
   * These could be sources (@linear, @github) or skills (@commit, @review-pr).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
}

/** Result of a prompt action - returns the prompt to be executed by caller */
export interface PromptActionResult {
  type: 'prompt';
  prompt: string;
  /** The expanded prompt with environment variables substituted */
  expandedPrompt: string;
  /** References to sources and skills found in the prompt */
  references: PromptReferences;
}

/** Result of a webhook action */
export interface WebhookActionResult {
  type: 'webhook';
  /** The URL that was called */
  url: string;
  /** HTTP status code from the response */
  statusCode: number;
  /** Whether the request was successful (2xx status) */
  success: boolean;
  /** Error message if the request failed */
  error?: string;
  /** Number of attempts made (1 = no retry, 2+ = retried) */
  attempts?: number;
  /** Total duration including retries, in ms */
  durationMs?: number;
  /** Captured response body (only when captureResponse is true, truncated to 4KB) */
  responseBody?: string;
}

export type ActionExecutionResult = PromptActionResult | WebhookActionResult;

/** A pending prompt with its metadata */
export interface PendingPrompt {
  /** The session ID this prompt should be sent to */
  sessionId: string | undefined;
  /** The automation matcher ID this prompt originated from */
  matcherId?: string;
  /** Human-readable automation name (from matcher.name or derived fallback) */
  automationName?: string;
  /** The expanded prompt text */
  prompt: string;
  /**
   * All @mentions found in the prompt (sources and skills).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
  /** Labels to apply to the created session */
  labels?: string[];
  /** Permission mode for the created session (from matcher config) */
  permissionMode?: PermissionMode;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /** Thinking level for the created session (falls back to workspace default when omitted) */
  thinkingLevel?: ThinkingLevel;
  /** When true, requests Anthropic fast mode for the created session. */
  fastMode?: boolean;
  /** Forum-topic name to bind the new session to (Telegram supergroup, when paired). */
  telegramTopic?: string;
  /**
   * fork(PLAN-017): the matcher's onFailure actions, carried through so the host
   * can run them when this prompt's dispatch or outcome record is not-ok. Only
   * present on records with a `matcherId` (onFailure-spawned prompts carry none).
   */
  onFailure?: (PromptAction | WebhookAction)[];
}

export interface AutomationResult {
  event: string;
  matched: number;
  results: ActionExecutionResult[];
  /** Prompts that should be executed by Craft Agent (with metadata) */
  pendingPrompts: PendingPrompt[];
}

/**
 * fork(PLAN-014): a resolved session-mutation action ready for the host to
 * execute. The handler computes (expands `$ENV` and `$.jsonpath`); the host
 * executes (resolves label→session, validates, writes to disk).
 */
export interface PendingSessionAction {
  /** Originating matcher ID (for history correlation). */
  matcherId?: string;
  /** Human-readable automation name. */
  automationName?: string;
  /** The action kind. */
  type: 'set-status' | 'set-labels' | 'send-message';
  /** Target selector with `$ENV`/`$.jsonpath` already expanded to literals. */
  target: SessionTargetSelector;
  /** set-status */
  status?: string;
  /** set-status: allow closing statuses (done/cancelled). */
  allowClosed?: boolean;
  /** set-labels */
  add?: string[];
  remove?: string[];
  /** send-message */
  message?: string;
  /** Correlation to the originating webhook delivery. */
  hookId?: string;
  eventId?: string;
}

// ============================================================================
// Validation Types
// ============================================================================

/** Internal validation result that includes the parsed config */
export type AutomationsValidationResult = {
  valid: boolean;
  errors: string[];
  config: AutomationsConfig | null;
};

// ============================================================================
// SDK Types
// ============================================================================

/**
 * SDK automation input type - union of all possible SDK event inputs
 */
export interface SdkAutomationInput {
  hook_event_name: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_use_id?: string;
  // Session events
  source?: string;  // startup, resume, clear, compact
  model?: string;
  // Subagent events
  agent_id?: string;
  agent_type?: string;
  // User prompt events
  prompt?: string;
  // Notification events
  message?: string;
  title?: string;
  // Error events
  error?: string;
}

/**
 * SDK automation callback signature (matches Claude SDK HookCallback type)
 */
export type SdkAutomationCallback = (
  input: SdkAutomationInput,
  toolUseId: string,
  options: { signal?: AbortSignal }
) => Promise<{ continue: boolean; reason?: string }>;

/**
 * SDK automation matcher format (matches Claude SDK HookCallbackMatcher type)
 * Note: The `hooks` field name is kept as-is to match the Claude SDK interface.
 */
export interface SdkAutomationCallbackMatcher {
  matcher?: string;
  timeout?: number;
  hooks: SdkAutomationCallback[];
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Lightweight session metadata for diffing.
 * Only includes fields that trigger automations.
 */
export interface SessionMetadataSnapshot {
  permissionMode?: string;
  labels?: string[];
  isFlagged?: boolean;
  sessionStatus?: string;
  /** Session name (user-defined or auto-generated) */
  sessionName?: string;
}
