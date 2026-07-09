/**
 * Automations Schema Definitions
 *
 * Zod schemas for validating automations.json configuration.
 * Extracted from index.ts for better separation of concerns.
 */

import { z } from 'zod';
import type { ValidationIssue } from '../config/validators.ts';
import { APP_EVENTS, AGENT_EVENTS } from './types.ts';
import { THINKING_LEVEL_IDS, normalizeThinkingLevel } from '../agent/thinking-levels.ts';

// ============================================================================
// Zod Schemas
// ============================================================================

// Mirrors the workspace-default pattern in `config/storage.ts` so that the
// legacy 'think' value is silently migrated to a current thinking level.
const ThinkingLevelInputSchema = z
  .enum([...THINKING_LEVEL_IDS, 'think'])
  .transform((value) => normalizeThinkingLevel(value))
  .optional();

export const PromptActionSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1, 'Prompt cannot be empty'),
  llmConnection: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelInputSchema,
  fastMode: z.boolean().optional(),
});

export const WebhookActionSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().min(1, 'URL cannot be empty').refine(
    (url) => {
      // Allow env var templates — validated at runtime after expansion
      if (url.includes('$')) return true;
      // Literal URLs must be valid http/https
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    'URL must be a valid http/https URL or contain $VAR templates'
  ),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyFormat: z.enum(['json', 'form', 'raw']).optional(),
  body: z.unknown().optional(),
  captureResponse: z.boolean().optional(),
  auth: z.union([
    z.object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: z.string(),
    }),
    z.object({
      type: z.literal('bearer'),
      token: z.string().min(1),
    }),
  ]).optional(),
});

// ============================================================================
// Session Actions (fork(PLAN-014))
// ============================================================================

/** Exactly one of id/label; both support $ENV and $.jsonpath (resolved at runtime). */
export const SessionTargetSelectorSchema = z
  .object({
    id: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  })
  .refine(
    (s) => (s.id === undefined) !== (s.label === undefined),
    'session selector must set exactly one of "id" or "label"',
  );

export const SetStatusActionSchema = z.object({
  type: z.literal('set-status'),
  session: SessionTargetSelectorSchema,
  status: z.string().min(1),
  allowClosed: z.boolean().optional(),
});

export const SetLabelsActionSchema = z
  .object({
    type: z.literal('set-labels'),
    session: SessionTargetSelectorSchema,
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (a) => (a.add?.length ?? 0) + (a.remove?.length ?? 0) > 0,
    'set-labels requires at least one of "add" or "remove"',
  );

export const SendMessageActionSchema = z.object({
  type: z.literal('send-message'),
  session: SessionTargetSelectorSchema,
  message: z.string().min(1),
});

/** Accepts prompt and webhook actions strictly; passes through legacy/unknown action types without erroring */
export const ActionDefinitionSchema = z.union([
  PromptActionSchema,
  WebhookActionSchema,
  SetStatusActionSchema,
  SetLabelsActionSchema,
  SendMessageActionSchema,
  z.object({ type: z.string() }).passthrough(),
]);

// ============================================================================
// Hook Registration Schema (fork(PLAN-014))
// ============================================================================

const HookVerificationSchema = z.object({
  type: z.literal('hmac-sha256'),
  secretEnv: z.string().regex(/^CRAFT_WH_[A-Z0-9_]+$/, 'secretEnv must match ^CRAFT_WH_[A-Z0-9_]+$'),
  signatureHeader: z.string().min(1),
  timestampToleranceMs: z.number().int().positive().optional(),
});

const HookIdempotencyKeySchema = z.object({
  source: z.enum(['header', 'body']),
  name: z.string().min(1),
});

const HookDebounceSchema = z.object({
  windowMs: z.number().int().nonnegative(),
  maxWaitMs: z.number().int().positive().optional(),
  strategy: z.enum(['trailing', 'collect']).optional(),
  debounceKey: z.string().optional(),
});

const HookRateLimitSchema = z.object({
  perMinute: z.number().int().positive().max(100000),
  burst: z.number().int().nonnegative().optional(),
});

const HookConcurrencySchema = z.object({
  maxActiveSessions: z.number().int().positive(),
  overflow: z.enum(['queue', 'coalesce', 'drop']).optional(),
});

export const HookConfigSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/, 'slug must match [a-z0-9-]{1,64}'),
  tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'tokenHash must be "sha256:<hex64>"'),
  tokenPrefix: z.string().optional(),
  verification: HookVerificationSchema.optional(),
  idempotencyKey: HookIdempotencyKeySchema.optional(),
  debounce: HookDebounceSchema.optional(),
  rateLimit: HookRateLimitSchema.optional(),
  concurrency: HookConcurrencySchema.optional(),
  bodyCapBytes: z.number().int().positive().optional(),
});

// ============================================================================
// Condition Schemas
// ============================================================================

const VALID_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const TimeConditionSchema = z.object({
  condition: z.literal('time'),
  after: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  before: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  weekday: z.array(z.enum(VALID_WEEKDAYS)).optional(),
  timezone: z.string().optional(),
});

export const StateConditionSchema = z.object({
  condition: z.literal('state'),
  field: z.string().min(1, 'Field name cannot be empty'),
  value: z.unknown().optional(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  contains: z.string().optional(),
  not_value: z.unknown().optional(),
}).superRefine((data, ctx) => {
  const hasValue = data.value !== undefined;
  const hasFromOrTo = data.from !== undefined || data.to !== undefined;
  const hasContains = data.contains !== undefined;
  const hasNotValue = data.not_value !== undefined;

  const operatorCount =
    (hasValue ? 1 : 0) +
    (hasFromOrTo ? 1 : 0) +
    (hasContains ? 1 : 0) +
    (hasNotValue ? 1 : 0);

  if (operatorCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must have at least one operator (value, from/to, contains, or not_value)',
      path: ['field'],
    });
    return;
  }

  if (operatorCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)',
      path: ['field'],
    });
  }
});

export const AutomationConditionSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('condition', [
    TimeConditionSchema,
    StateConditionSchema,
    z.object({
      condition: z.enum(['and', 'or', 'not']),
      conditions: z.array(AutomationConditionSchema).min(1, 'Logical condition must have at least one sub-condition'),
    }),
  ])
);

// ============================================================================
// Matcher Schema
// ============================================================================

export const AutomationMatcherSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  matcher: z.string().optional(),
  cron: z.string().optional(),
  // fork(PLAN-014): hook registration + payload match field
  hook: HookConfigSchema.optional(),
  matchField: z.string().optional(),
  timezone: z.string().optional(),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional(),
  labels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(AutomationConditionSchema).optional(),
  // Telegram forum-topic name (1–128 chars). Silently ignored at runtime when
  // no supergroup is paired or the Telegram adapter is not connected.
  telegramTopic: z.string().min(1).max(128).optional(),
  actions: z.array(ActionDefinitionSchema).min(1, 'At least one action required'),
});

/**
 * Deprecated event name aliases.
 * Old names are accepted during schema validation and silently rewritten to canonical names.
 * A console.warn() is emitted at runtime so users know to update their configs.
 */
export const DEPRECATED_EVENT_ALIASES: Record<string, string> = {
  'TodoStateChange': 'SessionStatusChange',
};

/** All valid event names: canonical events + deprecated aliases. Derived from types.ts. */
export const VALID_EVENTS: readonly string[] = [
  ...APP_EVENTS,
  ...AGENT_EVENTS,
  ...Object.keys(DEPRECATED_EVENT_ALIASES),
];

export const AutomationsConfigSchema = z.object({
  version: z.number().optional(),
  automations: z.record(z.string(), z.array(AutomationMatcherSchema)).optional(),
}).transform((data) => {
  const automations = data.automations ?? {};

  // Filter out invalid event names, rewrite deprecated aliases, and warn
  const validAutomations: Record<string, z.infer<typeof AutomationMatcherSchema>[]> = {};
  const invalidEvents: string[] = [];

  for (const [event, matchers] of Object.entries(automations)) {
    if (VALID_EVENTS.includes(event)) {
      // Rewrite deprecated aliases to canonical names
      const canonical = DEPRECATED_EVENT_ALIASES[event];
      if (canonical) {
        console.warn(`[automations] Deprecated event name "${event}" — use "${canonical}" instead`);
        validAutomations[canonical] = [...(validAutomations[canonical] ?? []), ...matchers];
      } else {
        validAutomations[event] = [...(validAutomations[event] ?? []), ...matchers];
      }
    } else {
      invalidEvents.push(event);
    }
  }

  if (invalidEvents.length > 0) {
    console.warn(`[automations] Unknown event types ignored: ${invalidEvents.join(', ')}`);
  }

  return { version: data.version, automations: validAutomations };
});

// ============================================================================
// Schema Utilities
// ============================================================================

/**
 * Convert Zod error to ValidationIssues (matches validators.ts pattern)
 */
export function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}
