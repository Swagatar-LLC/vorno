/**
 * Craft Agent Automations - Public API
 *
 * Slim barrel file that re-exports from decomposed modules:
 * - types.ts: All type definitions
 * - validation.ts: Config validation functions
 * - sdk-bridge.ts: SDK environment variable building
 * - utils.ts: Shared utilities (toSnakeCase, expandEnvVars, etc.)
 * - automation-system.ts: AutomationSystem facade (main entry point)
 * - event-bus.ts: WorkspaceEventBus
 * - handlers/: PromptHandler, WebhookHandler, EventLogHandler
 */

// ============================================================================
// Types
// ============================================================================

export type {
  AppEvent,
  AgentEvent,
  AutomationEvent,
  PromptAction,
  WebhookAction,
  WebhookHttpMethod,
  WebhookBodyFormat,
  WebhookAuth,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  PromptReferences,
  PromptActionResult,
  WebhookActionResult,
  ActionExecutionResult,
  PendingPrompt,
  AutomationResult,
  // fork(PLAN-014)
  HookConfig,
  HookVerification,
  HookIdempotencyKey,
  HookDebounce,
  HookRateLimit,
  HookConcurrency,
  SessionTargetSelector,
  SetStatusAction,
  SetLabelsAction,
  SendMessageAction,
  SessionAction,
  PendingSessionAction,
  AutomationsValidationResult,
  SdkAutomationInput,
  SdkAutomationCallback,
  SdkAutomationCallbackMatcher,
  SessionMetadataSnapshot,
  TimeCondition,
  StateCondition,
  LogicalCondition,
  AutomationCondition,
} from './types.ts';

export { APP_EVENTS, AGENT_EVENTS } from './types.ts';

// ============================================================================
// Validation
// ============================================================================

export {
  validateAutomationsConfig,
  validateAutomationsContent,
  validateAutomations,
} from './validation.ts';

// ============================================================================
// SDK Bridge
// ============================================================================

export { buildEnvFromSdkInput } from './sdk-bridge.ts';

// ============================================================================
// Utilities
// ============================================================================

export { parsePromptReferences } from './utils.ts';

// ============================================================================
// Re-exports from sub-modules
// ============================================================================

// Event logger
export { AutomationEventLogger, type LoggedAutomationEvent, type LoggedAutomationEventInput } from './event-logger.ts';

// Schemas
export { AutomationsConfigSchema, AutomationConditionSchema, TimeConditionSchema, StateConditionSchema, zodErrorToIssues, VALID_EVENTS } from './schemas.ts';

// Condition evaluator
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// Security utilities
export { sanitizeForShell } from './security.ts';

// Webhook execution utilities
export { executeWebhookRequest, executeWithRetry, createWebhookHistoryEntry, createPromptHistoryEntry, createOutcomeHistoryEntry, createMissedHistoryEntry, type ExecuteWebhookOptions, type RetryConfig } from './webhook-utils.ts';

// fork(PLAN-017): missed-fire detection + onFailure execution
export { detectMissedFires, type DetectMissedFiresInput } from './missed-fire.ts';
export { runOnFailureActions, type OnFailureContext, type RunOnFailureOptions } from './on-failure.ts';

// Retry scheduler
export { RetryScheduler, type RetryQueueEntry, type RetrySchedulerOptions } from './retry-scheduler.ts';

// Config constants
export { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE, HISTORY_FIELD_MAX_LENGTH, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_HISTORY_MAX_ENTRIES } from './constants.ts';

// History store
export { appendAutomationHistoryEntry, compactAutomationHistory, compactAutomationHistorySync } from './history-store.ts';

// Config path resolution
export { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';

// Cron matching
export { matchesCron } from './cron-matcher.ts';

// Event Bus
export {
  WorkspaceEventBus,
  type EventBus,
  type EventPayloadMap,
  type BaseEventPayload,
  type LabelEventPayload,
  type PermissionModeChangePayload,
  type FlagChangePayload,
  type SessionStatusChangePayload,
  type SchedulerTickPayload,
  type LabelConfigChangePayload,
  type GenericEventPayload,
  type WebhookReceivedPayload,
  type EventHandler,
  type AnyEventHandler,
} from './event-bus.ts';

// AutomationSystem facade
export {
  AutomationSystem,
  type AutomationSystemOptions,
  type SessionMetadataSnapshot as AutomationSystemMetadataSnapshot,
} from './automation-system.ts';

// Handlers
export {
  PromptHandler,
  EventLogHandler,
  WebhookHandler,
  type AutomationHandler,
  type PromptHandlerOptions,
  type EventLogHandlerOptions,
  type WebhookHandlerOptions,
  type AutomationsConfigProvider,
} from './handlers/index.ts';

// fork(PLAN-014): webhook ingest (verify/dedup/rate/queue/receiver) + session actions
export { SessionActionHandler, type SessionActionHandlerOptions } from './handlers/session-action-handler.ts';
export {
  createWebhookReceiver,
  generateHookToken,
  hashHookToken,
  tokensMatch,
  extractIdempotencyKey,
  WebhookDedupStore,
  WebhookRateGate,
  WebhookIngestQueue,
  resolveJsonPathLite,
  resolveJsonPathLiteString,
  isValidJsonPathLite,
  verifyToken,
  withinBodyCap,
  createWebhookDispatcher,
  initWebhooks,
  readWebhookMatchers,
  resolveWorkspaceById,
  type WebhookReceiver,
  type WebhookReceiverDeps,
  type WebhookRequest,
  type WebhookResult,
  type ResolvedWorkspace,
  type MintedHookToken,
  type IngestQueueEntry,
  type WebhookDispatch,
  type WebhookDispatcherHandle,
  type WebhookDispatcherExecutors,
  type WebhookDispatcherDeps,
  type WebhookPromptExecutor,
  type WebhookSessionActionExecutor,
  type ExecResult,
  type WebhooksHandle,
} from './webhook-ingest/index.ts';
export {
  WEBHOOK_TOKEN_PREFIX,
  WEBHOOK_DEFAULT_BODY_CAP_BYTES,
  WEBHOOK_DEFAULT_RATE_PER_MINUTE,
  WEBHOOKS_PAYLOADS_DIR,
} from './constants.ts';

// fork(PLAN-014) Phase 3: webhook management (CRUD over WebhookReceived matchers)
export {
  listWebhooks,
  upsertWebhook,
  revokeWebhookToken,
  readWebhookDeliveries,
  type WebhookSummary,
  type WebhookUpsertInput,
  type WebhookUpsertResult,
  type WebhookRevokeAction,
  type WebhookRevokeResult,
  type WebhookDelivery,
} from './webhook-management.ts';
