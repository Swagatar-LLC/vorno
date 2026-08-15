/**
 * Automation System Validation
 *
 * Validators for automations.json configuration files.
 * Used by PreToolUse automations and workspace validators.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAutomationsConfigPath } from './resolve-config-path.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import { AutomationsConfigSchema, AutomationMatcherSchema, KNOWN_ACTION_TYPES, KNOWN_ACTION_SCHEMAS, zodErrorToIssues, DEPRECATED_EVENT_ALIASES, VALID_EVENTS } from './schemas.ts';
import { isValidLabelId } from '../labels/storage.ts';
import { extractLabelId } from '../labels/values.ts';
import { getLlmConnection } from '../config/storage.ts';
import { getDefaultModelsForConnection } from '../config/llm-connections.ts';
import type { ModelDefinition } from '../config/models.ts';
import { Cron } from 'croner';
import type { ValidationResult, ValidationIssue } from '../config/validators.ts';
import type { AutomationsConfig, AutomationsValidationResult } from './types.ts';
import { MAX_CONDITION_DEPTH_EXCLUSIVE, CONDITION_DEPTH_WARNING_THRESHOLD } from './conditions-constants.ts';
import { isValidJsonPathLite } from './webhook-ingest/jsonpath-lite.ts';

/** fork(PLAN-017): action types permitted inside a matcher's `onFailure` list. */
const ONFAILURE_ALLOWED_ACTION_TYPES = new Set(['prompt', 'webhook']);

/**
 * fork(PLAN-030): invented action types seen in the wild, mapped to the real
 * type — or to `null` where no equivalent exists yet.
 *
 * Keys are normalized (lowercase, separators stripped) so `setSessionStatus`,
 * `set_session_status`, and `SetSessionStatus` all resolve to one entry. These
 * are hallucination patterns: plausible-reading names an agent or a human
 * reaches for when the docs don't list the real vocabulary. Naming the right
 * type is what turns a silent no-op into a one-line fix.
 */
const ACTION_TYPE_ALIASES: Record<string, string | null> = {
  setsessionstatus: 'set-status',
  setstatus: 'set-status',
  updatestatus: 'set-status',
  setsessionlabels: 'set-labels',
  setlabels: 'set-labels',
  addlabel: 'set-labels',
  addlabels: 'set-labels',
  sendmessage: 'send-message',
  message: 'send-message',
  // fork(PLAN-030 Phase 3): these were `null` — "no equivalent today" — and they were the
  // reason the phase exists. Now that `apply-context` is real they all suggest it, which
  // is the whole point of the profile indirection: someone reaching for a per-knob action
  // type gets pointed at the one action that covers every knob, instead of at a list that
  // doesn't contain what they wanted. `enableskill` is included deliberately even though a
  // profile cannot carry skills — `apply-context` is still the right destination to be
  // sent to, and the profile schema names the skills limitation precisely when they get
  // there, which is a far better error than "valid action types are: …".
  addworkingdirectory: 'apply-context',
  setworkingdirectory: 'apply-context',
  enableskill: 'apply-context',
  enablesource: 'apply-context',
  applycontext: 'apply-context',
};

/**
 * fork(PLAN-030): invented matcher keys mapped to the real key.
 *
 * `labelId` is the load-bearing entry: it reads like a filter, so a rule using
 * it looks filtered while `matcher` stays unset — and an unset `matcher` means
 * *match everything* (`matchesBasePredicate`). The rule fires on every event of
 * its type instead of none, which is the more dangerous of the two failures.
 */
const MATCHER_KEY_ALIASES: Record<string, string | null> = {
  labelid: 'matcher',
  label: 'matcher',
  labelname: 'matcher',
  status: 'matcher',
  statusid: 'matcher',
  toolname: 'matcher',
  pattern: 'matcher',
  regex: 'matcher',
  schedule: 'cron',
  crontab: 'cron',
  tz: 'timezone',
  disabled: 'enabled',
  mode: 'permissionMode',
};

/**
 * fork(PLAN-030): suggestions that must say more than "did you mean X".
 *
 * `disabled` is the dangerous one. The real key is `enabled`, but the *value*
 * has to flip with it: someone who wrote `"disabled": true` wants the rule off,
 * and following a bare `Did you mean "enabled"?` gets them `"enabled": true` —
 * the exact opposite of their intent, on a rule that is currently still firing
 * (an invented `disabled` key is inert; only a real `enabled: false` parks a
 * rule, and only a parked rule is exempt from these scans).
 */
const KEY_SUGGESTION_OVERRIDES: Record<string, string> = {
  matcher:
    'Filtering is done with "matcher" (a regex), e.g. "matcher": "^auto-close$". Without it the rule matches EVERY event of this type.',
  disabled:
    'Use "enabled": false to turn a rule off — note the value flips. "disabled" is ignored, so this rule is still running.',
};

/**
 * Keys treated as deliberate inline documentation rather than mistakes.
 *
 * JSON has no comment syntax, so annotating a rule means adding a key the
 * schema will strip. That is intentional and harmless — warning about it every
 * validation is noise that trains people to ignore the warnings that matter.
 */
const ANNOTATION_KEYS = new Set(['comment', '_comment', 'note', 'notes', 'reason', 'description', 'doc', '$schema']);

/** Normalize a type/key name for alias and token comparison. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Split a camelCase / kebab / snake name into lowercase tokens. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Best-effort "did you mean" for an unrecognized name.
 *
 * Alias table first (exact, highest confidence), then token containment — the
 * candidate whose tokens are all present in the offending name, preferring the
 * most specific. `setSessionStatus` → tokens {set, session, status} ⊇ {set,
 * status} → `set-status`.
 *
 * Single-token candidates are never suggested for a multi-token name: `labelId`
 * tokenizes to {label, id}, which contains the key `id`, but steering someone
 * from a mis-keyed filter to the matcher's own identifier is worse than saying
 * nothing. A wrong suggestion costs more than no suggestion — when in doubt,
 * return undefined and list the valid names instead.
 */
function suggestName(
  name: string,
  candidates: readonly string[],
  aliases: Record<string, string | null>,
): string | undefined {
  const normalized = normalizeName(name);
  if (normalized in aliases) {
    return aliases[normalized] ?? undefined;
  }
  const tokens = nameTokens(name);
  const tokenSet = new Set(tokens);
  let best: string | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const candidateTokens = nameTokens(candidate);
    // Require a multi-token overlap unless the name is itself a single token
    // (so `crontab` → `cron` still works, but `labelId` → `id` does not).
    if (candidateTokens.length < 2 && tokens.length > 1) continue;
    if (!candidateTokens.every((t) => tokenSet.has(t))) continue;
    if (candidateTokens.length > bestScore) {
      best = candidate;
      bestScore = candidateTokens.length;
    }
  }
  return best;
}

/** Matcher keys the schema actually understands — derived, so it can't drift. */
function knownMatcherKeys(): string[] {
  return Object.keys(AutomationMatcherSchema.shape);
}

/**
 * fork(PLAN-030): walk raw config content, invoking `visit` for each matcher.
 *
 * Operates on raw (pre-schema) content because Zod has already stripped unknown
 * matcher keys by the time a parsed config exists — the stripping is exactly
 * what we need to report. Best-effort and defensive: malformed shapes are
 * skipped, never thrown on.
 *
 * `enabled: false` matchers are skipped. These scans answer "will this rule do
 * what it says?", and a rule the user has deliberately turned off is not
 * claiming to do anything — flagging it would make a parked rule permanently
 * fail validation and re-log a diagnostic on every load. The report reappears
 * the moment it is re-enabled, which is when it matters again.
 */
function forEachRawMatcher(
  content: unknown,
  visit: (matcher: Record<string, unknown>, event: string, index: number) => void,
): void {
  const automations = (content as { automations?: unknown } | null)?.automations;
  if (!automations || typeof automations !== 'object') return;
  for (const [event, matchers] of Object.entries(automations as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) continue;
      if ((matcher as Record<string, unknown>).enabled === false) continue;
      visit(matcher as Record<string, unknown>, event, i);
    }
  }
}

/**
 * fork(PLAN-030): report action types no handler will ever dispatch.
 *
 * The schema's `.passthrough()` member cannot reject these (see
 * `ActionDefinitionSchema`), so without this scan an invented type validates
 * clean and silently never runs.
 */
export function scanUnknownActionTypes(content: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  forEachRawMatcher(content, (matcher, event, i) => {
    const actions = matcher.actions;
    if (!Array.isArray(actions)) return;
    for (let j = 0; j < actions.length; j++) {
      const action = actions[j] as { type?: unknown } | null;
      const type = action && typeof action === 'object' ? action.type : undefined;
      if (typeof type !== 'string' || (KNOWN_ACTION_TYPES as readonly string[]).includes(type)) continue;
      const suggestion = suggestName(type, KNOWN_ACTION_TYPES, ACTION_TYPE_ALIASES);
      issues.push({
        file,
        path: `automations.${event}[${i}].actions[${j}].type`,
        message: `Unknown action type "${type}" — no handler will run this action`,
        severity: 'error',
        suggestion: suggestion
          ? `Did you mean "${suggestion}"?`
          : `Valid action types are: ${KNOWN_ACTION_TYPES.join(', ')}`,
      });
    }
  });
  return issues;
}

/**
 * fork(PLAN-030): report matcher keys the schema will silently strip.
 *
 * Warning, not error — an unknown key is inert on its own. It is dangerous in
 * one specific way, called out in the suggestion: a mis-keyed filter (e.g.
 * `labelId` instead of `matcher`) leaves `matcher` unset, and
 * `matchesBasePredicate` treats an unset `matcher` as *match everything*. The
 * rule doesn't fail closed, it fires on every event.
 */
export function scanUnknownMatcherKeys(content: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = knownMatcherKeys();
  forEachRawMatcher(content, (matcher, event, i) => {
    for (const key of Object.keys(matcher)) {
      if (known.includes(key) || ANNOTATION_KEYS.has(key.toLowerCase())) continue;
      const suggestion = suggestName(key, known, MATCHER_KEY_ALIASES);
      // Keyed on the offending key first (so `disabled` gets the value-flip
      // warning), then on the suggested key (so any mis-keyed filter gets the
      // matches-everything warning).
      const override = KEY_SUGGESTION_OVERRIDES[normalizeName(key)] ?? (suggestion ? KEY_SUGGESTION_OVERRIDES[suggestion] : undefined);
      issues.push({
        file,
        path: `automations.${event}[${i}].${key}`,
        message: `Unknown matcher key "${key}" — it is ignored, not applied`,
        severity: 'warning',
        suggestion: override
          ?? (suggestion ? `Did you mean "${suggestion}"?` : `Valid keys are: ${known.join(', ')}`),
      });
    }
  });
  return issues;
}

/**
 * fork(PLAN-030): report actions whose `type` is real but whose shape is not.
 *
 * The second dead-rule class, and the nastier one. `{"type": "set-status"}` with
 * no `session`/`status` fails `SetStatusActionSchema`, falls through to the
 * union's catch-all, and validates clean — `scanUnknownActionTypes` can't see it
 * because it only checks the type *name*. At runtime it doesn't quietly no-op
 * the way an invented type does: the handler dereferences the missing selector
 * and throws, which used to discard every action queued for that event,
 * including healthy ones from unrelated matchers (see the per-action isolation
 * in `session-action-handler.ts`).
 *
 * Checked against the schema the action's own `type` names, with no fallback —
 * that is the whole point.
 */
export function scanMalformedKnownActions(content: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  forEachRawMatcher(content, (matcher, event, i) => {
    const actions = matcher.actions;
    if (!Array.isArray(actions)) return;
    for (let j = 0; j < actions.length; j++) {
      const detail = describeMalformedAction(actions[j]);
      if (!detail) continue;
      issues.push({
        file,
        path: `automations.${event}[${i}].actions[${j}]`,
        message: `Action "${detail.type}" is missing or misusing required fields — it cannot run (${detail.reason})`,
        severity: 'error',
        suggestion: `Fix the highlighted field(s) on this ${detail.type} action`,
      });
    }
  });
  return issues;
}

/**
 * Validate one raw action against the schema its own `type` names.
 * Returns `null` for anything that isn't a malformed *known* action (unknown
 * types are `scanUnknownActionTypes`' job, not this one).
 */
function describeMalformedAction(action: unknown): { type: string; reason: string } | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const type = (action as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  const schema = KNOWN_ACTION_SCHEMAS[type as keyof typeof KNOWN_ACTION_SCHEMAS];
  if (!schema) return null;
  const parsed = schema.safeParse(action);
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  const path = first?.path.join('.');
  const reason = first ? (path ? `${path}: ${first.message}` : first.message) : 'invalid shape';
  return { type, reason };
}

/**
 * fork(PLAN-030): report event names the config schema silently drops.
 *
 * `AutomationsConfigSchema`'s transform discards any key that isn't a known
 * event and emits one lumped `console.warn`. Every matcher underneath it is
 * gone — same "validates clean, can never run" failure the other scans exist to
 * close, just at the level above them. A near-miss against `VALID_EVENTS`
 * usually names the fix outright (`LabelAdded` → `LabelAdd`).
 *
 * Matched against the canonical event list case-insensitively for the
 * suggestion only; the config itself remains case-sensitive.
 */
export function scanUnknownEventNames(content: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const automations = (content as { automations?: unknown } | null)?.automations;
  if (!automations || typeof automations !== 'object' || Array.isArray(automations)) return issues;

  for (const [event, matchers] of Object.entries(automations as Record<string, unknown>)) {
    if (VALID_EVENTS.includes(event)) continue;
    // Mirror the per-matcher exemption: a block of parked rules isn't claiming
    // to do anything, so don't hold the config hostage to it.
    if (Array.isArray(matchers) && matchers.length > 0 && matchers.every(
      (m) => m && typeof m === 'object' && (m as Record<string, unknown>).enabled === false,
    )) continue;

    const count = Array.isArray(matchers) ? matchers.length : 0;
    const suggestion = suggestEventName(event);
    issues.push({
      file,
      path: `automations.${event}`,
      message: `Unknown event "${event}" — the whole block is discarded at load${count > 0 ? `, taking ${count} matcher(s) with it` : ''}`,
      severity: 'error',
      suggestion: suggestion
        ? `Did you mean "${suggestion}"?`
        : `Valid events are: ${VALID_EVENTS.join(', ')}`,
    });
  }
  return issues;
}

/**
 * Case-insensitive exact match, then prefix containment, then token overlap.
 *
 * The prefix pass is what catches the common shape: `LabelAdded` normalizes to
 * `labeladded`, which token matching misses (`added` ≠ `add`) but which has
 * `labeladd` as a prefix. Requires a substantial overlap so short events can't
 * be suggested for unrelated names.
 */
function suggestEventName(event: string): string | undefined {
  const normalized = normalizeName(event);
  if (!normalized) return undefined;

  const exact = VALID_EVENTS.find((e) => normalizeName(e) === normalized);
  if (exact) return exact;

  let best: string | undefined;
  for (const candidate of VALID_EVENTS) {
    const c = normalizeName(candidate);
    const shorter = Math.min(c.length, normalized.length);
    if (shorter < 5) continue;
    if (!c.startsWith(normalized) && !normalized.startsWith(c)) continue;
    // Prefer the closest-length candidate — `LabelAdd` over `LabelAddX`.
    if (!best || Math.abs(c.length - normalized.length) < Math.abs(normalizeName(best).length - normalized.length)) {
      best = candidate;
    }
  }
  if (best) return best;

  return suggestName(event, VALID_EVENTS, {});
}

/**
 * fork(PLAN-030): matcher ids whose actions include an unrecognized type.
 *
 * Used at load time to record dead rules in history — a rule that cannot run
 * must be visible somewhere, and history is where operators look.
 */
export function findMatchersWithUnknownActions(content: unknown): Array<{ id: string; event: string; types: string[] }> {
  const dead: Array<{ id: string; event: string; types: string[] }> = [];
  forEachRawMatcher(content, (matcher, event, i) => {
    const actions = matcher.actions;
    if (!Array.isArray(actions)) return;
    const types = actions
      .map((a) => (a && typeof a === 'object' ? (a as { type?: unknown }).type : undefined))
      .filter((t): t is string => typeof t === 'string' && !(KNOWN_ACTION_TYPES as readonly string[]).includes(t));
    if (types.length > 0) {
      dead.push({ id: typeof matcher.id === 'string' ? matcher.id : `${event}[${i}]`, event, types });
    }
  });
  return dead;
}

/**
 * fork(PLAN-030): one diagnostic per rule that loaded but can never run.
 *
 * The load path stays lenient (ADR-0021 §4), so "can never run" has to be
 * reported out-of-band rather than as a validation error. This is the single
 * collector behind those reports — every dead-rule class the scans know about,
 * flattened into a shape the history writer can record verbatim.
 *
 * Purely derived from raw content and never throws; callers treat it as
 * best-effort telemetry, not a gate.
 */
export interface ConfigDiagnostic {
  /** Matcher id, or `Event[index]` when the matcher has none. Event name for event-level problems. */
  id: string;
  event: string;
  reason: 'unknown-action-type' | 'invalid-action-shape' | 'unknown-event';
  detail: string;
}

export function collectConfigDiagnostics(content: unknown): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  for (const { id, event, types } of findMatchersWithUnknownActions(content)) {
    diagnostics.push({ id, event, reason: 'unknown-action-type', detail: types.join(', ') });
  }

  forEachRawMatcher(content, (matcher, event, i) => {
    const actions = matcher.actions;
    if (!Array.isArray(actions)) return;
    const reasons = actions
      .map((a) => describeMalformedAction(a))
      .filter((d): d is { type: string; reason: string } => d !== null)
      .map((d) => `${d.type} (${d.reason})`);
    if (reasons.length > 0) {
      diagnostics.push({
        id: typeof matcher.id === 'string' ? matcher.id : `${event}[${i}]`,
        event,
        reason: 'invalid-action-shape',
        detail: reasons.join('; '),
      });
    }
  });

  for (const issue of scanUnknownEventNames(content, '')) {
    // `automations.<Event>` → `<Event>`; the block has no matcher id to key on.
    const event = issue.path.replace(/^automations\./, '');
    diagnostics.push({ id: event, event, reason: 'unknown-event', detail: issue.message });
  }

  return diagnostics;
}

/**
 * Validate automations config (internal - returns parsed config)
 */
export function validateAutomationsConfig(content: unknown): AutomationsValidationResult {
  const result = AutomationsConfigSchema.safeParse(content);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    // fork(PLAN-017): the strict onFailure union rejects disallowed action types
    // with an opaque "Invalid input". Scan the raw content for those and prepend
    // a clear, type-naming message so users know onFailure is the problem.
    const rawIssues = scanOnFailureActionTypes(content, AUTOMATIONS_CONFIG_FILE);
    const rawMessages = rawIssues.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);
    return { valid: false, errors: [...rawMessages, ...errors], config: null };
  }

  const schemaConfig = result.data as AutomationsConfig;
  const semanticErrors: ValidationIssue[] = [];
  runMatcherSemanticValidations(schemaConfig, AUTOMATIONS_CONFIG_FILE, semanticErrors, []);

  if (semanticErrors.length > 0) {
    const errors = semanticErrors.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message);
    return { valid: false, errors, config: null };
  }

  return { valid: true, errors: [], config: schemaConfig };
}

/**
 * Run semantic validation checks for matcher definitions.
 * Shared by both object-based runtime validation and JSON-content validation.
 */
function runMatcherSemanticValidations(
  config: AutomationsConfig,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const [event, matchers] of Object.entries(config.automations)) {
    if (!matchers) continue;
    // fork(PLAN-014): slug uniqueness is per-workspace, tracked across this
    // event's matchers (hooks only live on WebhookReceived).
    const seenHookSlugs = new Set<string>();
    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (!matcher) continue;

      // ----------------------------------------------------------------------
      // fork(PLAN-014): hook ↔ event exclusivity, slug uniqueness, matchField,
      // and action-type scoping.
      // ----------------------------------------------------------------------
      validateWebhookMatcher(matcher, event, i, seenHookSlugs, file, errors);

      // fork(PLAN-017): onFailure action-type scoping (prompt/webhook only).
      validateOnFailureActions(matcher, event, i, file, errors);

      // Warn about allow-all permission mode
      if (matcher.permissionMode === 'allow-all') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].permissionMode`,
          message: 'permissionMode "allow-all" bypasses all security checks — use with caution',
          severity: 'warning',
          suggestion: 'Consider using "safe" or "ask" permission mode instead',
        });
      }

      if (matcher.matcher) {
        // ReDoS prevention: limit regex complexity
        const MAX_REGEX_LENGTH = 500;
        if (matcher.matcher.length > MAX_REGEX_LENGTH) {
          errors.push({
            file,
            path: `automations.${event}[${i}].matcher`,
            message: `Regex pattern too long (${matcher.matcher.length} chars, max ${MAX_REGEX_LENGTH})`,
            severity: 'error',
            suggestion: 'Simplify the regex pattern or split into multiple matchers',
          });
        } else {
          try {
            // Validate regex syntax
            new RegExp(matcher.matcher);

            // Reject catastrophic backtracking (ReDoS) patterns
            // Detect nested quantifiers: a group containing a quantifier that itself has a quantifier
            const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*{]/;
            // Also detect repeated alternation like (a|a)+ and adjacent greedy quantifiers like .*.*
            const riskyPatterns = /(\.\*){2,}|(\.\+){2,}|\([^)]*\|[^)]*\)[+*{]/;
            if (nestedQuantifiers.test(matcher.matcher) || riskyPatterns.test(matcher.matcher)) {
              errors.push({
                file,
                path: `automations.${event}[${i}].matcher`,
                message: 'Regex pattern rejected: potential catastrophic backtracking (ReDoS)',
                severity: 'error',
                suggestion: 'Avoid nested quantifiers like (a+)+, (.*)+, (.+)*, ([a-z]+)+, and repeated alternation like (a|a)+',
              });
            }
          } catch (e) {
            errors.push({
              file,
              path: `automations.${event}[${i}].matcher`,
              message: `Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`,
              severity: 'error',
              suggestion: 'Fix the regex pattern or remove the matcher to match all events',
            });
          }
        }
      }

      // Validate cron expressions
      if (matcher.cron) {
        try {
          new Cron(matcher.cron);
        } catch (e) {
          errors.push({
            file,
            path: `automations.${event}[${i}].cron`,
            message: `Invalid cron expression: ${e instanceof Error ? e.message : 'Unknown error'}`,
            severity: 'error',
            suggestion: 'Use standard 5-field cron format: minute hour day-of-month month day-of-week',
          });
        }
      }

      // Validate timezone
      if (matcher.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: matcher.timezone });
        } catch {
          errors.push({
            file,
            path: `automations.${event}[${i}].timezone`,
            message: `Invalid timezone: ${matcher.timezone}`,
            severity: 'error',
            suggestion: 'Use IANA timezone format like "Europe/Budapest" or "America/New_York"',
          });
        }
      }

      // Warn about webhook URLs with $VAR templates (can't validate until runtime)
      if (matcher.actions) {
        for (let j = 0; j < matcher.actions.length; j++) {
          const action = matcher.actions[j];
          if (action && typeof action === 'object' && 'type' in action && action.type === 'webhook' && 'url' in action && typeof action.url === 'string' && action.url.includes('$')) {
            warnings.push({
              file,
              path: `automations.${event}[${i}].actions[${j}].url`,
              message: 'Webhook URL contains variable templates — will be validated at runtime after expansion',
              severity: 'warning',
              suggestion: 'Ensure the referenced CRAFT_WH_* variables are set in your shell profile',
            });
          }
        }
      }

      // Warn if cron is used on non-SchedulerTick event
      if (matcher.cron && event !== 'SchedulerTick') {
        warnings.push({
          file,
          path: `automations.${event}[${i}].cron`,
          message: 'Cron expressions are only used for SchedulerTick events',
          severity: 'warning',
          suggestion: 'Move this automation to the SchedulerTick event or use matcher instead',
        });
      }

      // Validate conditions
      if (matcher.conditions && Array.isArray(matcher.conditions)) {
        validateConditionsArray(matcher.conditions, `automations.${event}[${i}].conditions`, event, file, errors, warnings, 0);
      }
    }
  }
}

/**
 * fork(PLAN-014): semantic validation of webhook-specific matcher fields.
 * - `hook` is required on WebhookReceived matchers and rejected on all others
 *   (mirror of the cron↔SchedulerTick rule).
 * - hook slugs are unique per workspace (per event array here).
 * - `matchField` must be valid JSONPath-lite and is WebhookReceived-only.
 */
function validateWebhookMatcher(
  matcher: import('./types.ts').AutomationMatcher,
  event: string,
  i: number,
  seenHookSlugs: Set<string>,
  file: string,
  errors: ValidationIssue[],
): void {
  const isWebhookEvent = event === 'WebhookReceived';

  if (isWebhookEvent) {
    if (!matcher.hook) {
      errors.push({
        file,
        path: `automations.${event}[${i}].hook`,
        message: 'WebhookReceived matchers require a "hook" registration',
        severity: 'error',
        suggestion: 'Add a hook with a slug and tokenHash (mint one via mint-hook-token.ts)',
      });
    } else {
      const slug = matcher.hook.slug;
      if (seenHookSlugs.has(slug)) {
        errors.push({
          file,
          path: `automations.${event}[${i}].hook.slug`,
          message: `Duplicate hook slug "${slug}" — slugs must be unique per workspace`,
          severity: 'error',
          suggestion: 'Rename one of the hooks to a unique slug',
        });
      } else {
        seenHookSlugs.add(slug);
      }
    }
  } else if (matcher.hook) {
    errors.push({
      file,
      path: `automations.${event}[${i}].hook`,
      message: `"hook" is only valid on WebhookReceived matchers, not ${event}`,
      severity: 'error',
      suggestion: 'Move this matcher under the WebhookReceived event, or remove the hook field',
    });
  }

  // matchField — WebhookReceived-only, valid JSONPath-lite
  if (matcher.matchField !== undefined) {
    if (!isWebhookEvent) {
      errors.push({
        file,
        path: `automations.${event}[${i}].matchField`,
        message: `"matchField" is only valid on WebhookReceived matchers, not ${event}`,
        severity: 'error',
      });
    } else if (!isValidJsonPathLite(matcher.matchField)) {
      errors.push({
        file,
        path: `automations.${event}[${i}].matchField`,
        message: `Invalid matchField "${matcher.matchField}" — expected JSONPath-lite (e.g. $.type)`,
        severity: 'error',
        suggestion: 'Use $, $.field, $.a.b, or $.items[0].id',
      });
    }
  }

  // fork(PLAN-030) / ADR-0021 §1: `set-status` / `set-labels` / `send-message` used to be
  // rejected here on any non-WebhookReceived matcher. The scoping was a `(v1)` limitation,
  // not a security property — nothing about the webhook transport makes a status change
  // safer. It is gone, together with the runtime early-return in `session-action-handler.ts`
  // and *only* alongside the executor in `SessionManager.setupConfigWatcher`: dropping the
  // validation error without an executor would turn a loud misconfiguration into a rule that
  // validates clean and can never run. Loop safety moved to `causation.ts`.
}

/**
 * fork(PLAN-017): scan raw (pre-schema) config content for onFailure actions
 * whose `type` is not prompt/webhook, returning clear type-naming errors. Used
 * when the strict schema union has already rejected the config with an opaque
 * message. Best-effort and defensive — malformed shapes are simply ignored.
 */
function scanOnFailureActionTypes(content: unknown, file: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const automations = (content as { automations?: Record<string, unknown> } | null)?.automations;
  if (!automations || typeof automations !== 'object') return issues;

  for (const [event, matchers] of Object.entries(automations)) {
    if (!Array.isArray(matchers)) continue;
    for (let i = 0; i < matchers.length; i++) {
      const onFailure = (matchers[i] as { onFailure?: unknown })?.onFailure;
      if (!Array.isArray(onFailure)) continue;
      for (let j = 0; j < onFailure.length; j++) {
        const action = onFailure[j] as { type?: unknown } | undefined;
        const type = action && typeof action === 'object' ? action.type : undefined;
        if (typeof type !== 'string' || !ONFAILURE_ALLOWED_ACTION_TYPES.has(type)) {
          issues.push({
            file,
            path: `automations.${event}[${i}].onFailure[${j}]`,
            message: `onFailure action "${typeof type === 'string' ? type : 'unknown'}" is not allowed — only "prompt" and "webhook" actions may run on failure`,
            severity: 'error',
            suggestion: 'Use a prompt or webhook action in onFailure',
          });
        }
      }
    }
  }
  return issues;
}

/**
 * fork(PLAN-017): semantic validation of a matcher's `onFailure` list.
 * - Only `prompt` and `webhook` action types are permitted; anything else
 *   (set-status, set-labels, send-message, unknown) is rejected with a clear
 *   message. The Zod schema also rejects these, but its union error is opaque —
 *   this surfaces the offending index + type.
 */
function validateOnFailureActions(
  matcher: import('./types.ts').AutomationMatcher,
  event: string,
  i: number,
  file: string,
  errors: ValidationIssue[],
): void {
  const onFailure = (matcher as { onFailure?: unknown }).onFailure;
  if (!Array.isArray(onFailure)) return;

  for (let j = 0; j < onFailure.length; j++) {
    const action = onFailure[j] as { type?: unknown } | undefined;
    const type = action && typeof action === 'object' ? action.type : undefined;
    if (typeof type !== 'string' || !ONFAILURE_ALLOWED_ACTION_TYPES.has(type)) {
      errors.push({
        file,
        path: `automations.${event}[${i}].onFailure[${j}]`,
        message: `onFailure action "${typeof type === 'string' ? type : 'unknown'}" is not allowed — only "prompt" and "webhook" actions may run on failure`,
        severity: 'error',
        suggestion: 'Use a prompt or webhook action in onFailure',
      });
    }
  }
}

/**
 * Validate automations config from a JSON string (no disk reads).
 * Used by PreToolUse automation to validate before writing to disk.
 * Follows the same pattern as other config validators in validators.ts.
 */
export function validateAutomationsContent(jsonString: string, fileName?: string): ValidationResult {
  const file = fileName ?? AUTOMATIONS_CONFIG_FILE;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Parse JSON
  let content: unknown;
  try {
    content = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate schema
  const result = AutomationsConfigSchema.safeParse(content);
  if (!result.success) {
    // fork(PLAN-017): the strict onFailure union rejects disallowed action
    // types with an opaque "Invalid input" — prepend the clear, type-naming
    // messages here too (this path gates live config edits via PreToolUse).
    errors.push(...scanOnFailureActionTypes(content, file));
    errors.push(...zodErrorToIssues(result.error, file));
    return { valid: false, errors, warnings };
  }

  // Semantic validations
  const config = result.data;

  // Check for empty automations
  const matcherCount = Object.values(config.automations).reduce(
    (sum, matchers) => sum + (matchers?.length ?? 0),
    0
  );
  // fork(PLAN-030): "no automations configured" is actively misleading when the
  // file is full of rules under a typo'd event name — the transform discarded
  // them, so the count is legitimately zero. Let the unknown-event error below
  // be the whole story in that case.
  const unknownEventIssues = scanUnknownEventNames(content, file);
  if (matcherCount === 0 && unknownEventIssues.length === 0) {
    warnings.push({
      file,
      path: 'automations',
      message: 'No automations configured',
      severity: 'warning',
      suggestion: 'Add automation definitions under event names like SessionStatusChange, LabelAdd, etc.',
    });
  }

  // Check for deprecated event aliases in the raw JSON (before transform rewrites them)
  try {
    const rawConfig = JSON.parse(jsonString) as { automations?: Record<string, unknown> };
    if (rawConfig.automations) {
      for (const event of Object.keys(rawConfig.automations)) {
        const canonical = DEPRECATED_EVENT_ALIASES[event];
        if (canonical) {
          warnings.push({
            file,
            path: `automations.${event}`,
            message: `Event '${event}' has been renamed to '${canonical}'. The old name still works but is deprecated.`,
            severity: 'warning',
            suggestion: `Rename '${event}' to '${canonical}' in your config`,
          });
        }
      }
    }
  } catch {
    // JSON already validated above, this shouldn't happen
  }

  runMatcherSemanticValidations(config, file, errors, warnings);

  // fork(PLAN-030): raw-content scans for things the schema cannot reject —
  // unknown action types (swallowed by the ActionDefinitionSchema catch-all)
  // and unknown matcher keys (stripped by non-strict parsing). These run on the
  // inspection path only. The load path (validateAutomationsConfig) must stay
  // lenient: it zeroes the entire automations map on any error, so reporting a
  // single dead rule there would take every working automation down with it.
  // See ADR-0021 §4.
  errors.push(...scanUnknownActionTypes(content, file));
  errors.push(...scanMalformedKnownActions(content, file));
  errors.push(...unknownEventIssues);
  warnings.push(...scanUnknownMatcherKeys(content, file));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate automations.json from workspace path (reads from disk).
 * Follows the same pattern as other validators in validators.ts.
 */
export function validateAutomations(workspaceRoot: string): ValidationResult {
  const configPath = resolveAutomationsConfigPath(workspaceRoot);
  const file = 'automations.json';

  // Automations config is optional - no config means no automations (valid state)
  if (!existsSync(configPath)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file,
        path: '',
        message: 'No automations configuration found (no automations configured)',
        severity: 'warning',
      }],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Cannot read file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Parse JSON once — validateAutomationsContent also parses, but we need the
  // parsed object for workspace-aware validations below
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  // Validate content (schema + semantic checks)
  const contentResult = validateAutomationsContent(raw);
  if (!contentResult.valid) {
    return contentResult;
  }

  // Additional workspace-aware validations
  const errors: ValidationIssue[] = [];
  const warnings = [...contentResult.warnings];

  // Validate labels, llmConnection slugs, and model compatibility
  try {
    const config = content as { automations?: Record<string, Array<{ labels?: string[]; actions?: Array<{ type: string; llmConnection?: string; model?: string }> }>> };
    const labelEntries = config.automations;
    if (labelEntries) {
      for (const [event, matchers] of Object.entries(labelEntries)) {
        if (!matchers) continue;
        for (let i = 0; i < matchers.length; i++) {
          const matcher = matchers[i];
          if (matcher?.labels) {
            for (const label of matcher.labels) {
              // Extract label ID (handles "priority::3" -> "priority")
              const labelId = extractLabelId(label);
              if (!isValidLabelId(workspaceRoot, labelId)) {
                warnings.push({
                  file,
                  path: `automations.${event}[${i}].labels`,
                  message: `Label "${labelId}" does not exist in workspace`,
                  severity: 'warning',
                  suggestion: `Create this label in labels/config.json or use an existing label ID`,
                });
              }
            }
          }
          // Validate llmConnection slugs and model compatibility in prompt actions
          const actions = matcher?.actions;
          if (actions) {
            for (const action of actions) {
              if (action.type !== 'prompt') continue;

              if (action.llmConnection) {
                const connection = getLlmConnection(action.llmConnection);
                if (!connection) {
                  // Missing connection is an error — the automation will fail at runtime
                  // (falls back to default connection, which likely doesn't support the model)
                  errors.push({
                    file,
                    path: `automations.${event}[${i}].actions`,
                    message: `LLM connection "${action.llmConnection}" not found in config`,
                    severity: 'error',
                    suggestion: 'Check the connection slug in AI Settings or config.json',
                  });
                } else if (action.model) {
                  // Validate model is available for this connection
                  const availableModels = connection.models ?? getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
                  const modelIds = availableModels.map(m => typeof m === 'string' ? m : (m as ModelDefinition).id);
                  // Check exact match or suffix match (e.g. "haiku" matches "claude-haiku-4-5-20251001")
                  const modelValue = action.model;
                  const isAvailable = modelIds.some(id =>
                    id === modelValue || id.endsWith(`/${modelValue}`) ||
                    // Also match short aliases: "haiku" → any id containing "haiku", "sonnet" → "sonnet", etc.
                    id.toLowerCase().includes(modelValue.toLowerCase())
                  );
                  if (!isAvailable) {
                    warnings.push({
                      file,
                      path: `automations.${event}[${i}].actions`,
                      message: `Model "${modelValue}" may not be available on connection "${action.llmConnection}" (${connection.providerType})`,
                      severity: 'warning',
                      suggestion: `Available models: ${modelIds.slice(0, 5).join(', ')}${modelIds.length > 5 ? `, ... (${modelIds.length} total)` : ''}`,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // JSON already validated, this shouldn't happen
  }

  const allErrors = [...contentResult.errors, ...errors];
  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings,
  };
}

// ============================================================================
// Condition Validation Helpers
// ============================================================================

const VALID_WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const HH_MM_RE = /^\d{2}:\d{2}$/;

/** Events that have transition fields (from/to) */
const TRANSITION_EVENTS = new Set(['PermissionModeChange', 'SessionStatusChange']);

function validateConditionsArray(
  conditions: unknown[],
  basePath: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  depth: number,
): void {
  // Depth starts at 0 for top-level conditions; allowed depth indexes are
  // 0..MAX_CONDITION_DEPTH_EXCLUSIVE-1.
  if (depth > CONDITION_DEPTH_WARNING_THRESHOLD) {
    warnings.push({
      file,
      path: basePath,
      message: `Condition nesting depth ${depth} — consider simplifying`,
      severity: 'warning',
    });
  }
  if (depth >= MAX_CONDITION_DEPTH_EXCLUSIVE) {
    errors.push({
      file,
      path: basePath,
      message: `Condition nesting exceeds maximum depth of ${MAX_CONDITION_DEPTH_EXCLUSIVE}`,
      severity: 'error',
    });
    return;
  }

  for (let j = 0; j < conditions.length; j++) {
    const cond = conditions[j] as Record<string, unknown>;
    if (!cond || typeof cond !== 'object') continue;
    const path = `${basePath}[${j}]`;

    switch (cond.condition) {
      case 'time':
        validateTimeCondition(cond, path, file, errors);
        break;
      case 'state':
        validateStateCondition(cond, path, event, file, errors, warnings);
        break;
      case 'and':
      case 'or':
      case 'not':
        if (Array.isArray(cond.conditions) && cond.conditions.length > 0) {
          validateConditionsArray(cond.conditions, `${path}.conditions`, event, file, errors, warnings, depth + 1);
        }
        break;
    }
  }
}

function validateTimeCondition(
  cond: Record<string, unknown>,
  path: string,
  file: string,
  errors: ValidationIssue[],
): void {
  if (cond.after !== undefined && typeof cond.after === 'string') {
    if (!HH_MM_RE.test(cond.after)) {
      errors.push({ file, path: `${path}.after`, message: `Invalid time format: "${cond.after}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond.after.split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.after`, message: `Invalid time value: "${cond.after}"`, severity: 'error' });
      }
    }
  }
  if (cond.before !== undefined && typeof cond.before === 'string') {
    if (!HH_MM_RE.test(cond.before)) {
      errors.push({ file, path: `${path}.before`, message: `Invalid time format: "${cond.before}" (expected HH:MM)`, severity: 'error' });
    } else {
      const [h, m] = cond.before.split(':').map(Number);
      if ((h ?? 0) > 23 || (m ?? 0) > 59) {
        errors.push({ file, path: `${path}.before`, message: `Invalid time value: "${cond.before}"`, severity: 'error' });
      }
    }
  }
  if (cond.weekday !== undefined && Array.isArray(cond.weekday)) {
    for (const day of cond.weekday) {
      if (typeof day === 'string' && !VALID_WEEKDAYS.has(day)) {
        errors.push({ file, path: `${path}.weekday`, message: `Invalid weekday: "${day}" (expected mon-sun)`, severity: 'error' });
      }
    }
  }
  if (cond.timezone !== undefined && typeof cond.timezone === 'string') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: cond.timezone });
    } catch {
      errors.push({ file, path: `${path}.timezone`, message: `Invalid timezone: "${cond.timezone}"`, severity: 'error' });
    }
  }
}

function validateStateCondition(
  cond: Record<string, unknown>,
  path: string,
  event: string,
  file: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  // Check operator exclusivity
  const hasValue = cond.value !== undefined;
  const hasFrom = cond.from !== undefined;
  const hasTo = cond.to !== undefined;
  const hasContains = cond.contains !== undefined;
  const hasNotValue = cond.not_value !== undefined;

  const operatorCount = (hasValue ? 1 : 0) + ((hasFrom || hasTo) ? 1 : 0) + (hasContains ? 1 : 0) + (hasNotValue ? 1 : 0);
  if (operatorCount === 0) {
    errors.push({ file, path, message: 'State condition must have at least one operator (value, from/to, contains, or not_value)', severity: 'error' });
  } else if (operatorCount > 1) {
    errors.push({ file, path, message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)', severity: 'error' });
  }

  // Warn if from/to used on non-transition events
  if ((hasFrom || hasTo) && !TRANSITION_EVENTS.has(event)) {
    warnings.push({
      file,
      path,
      message: `from/to transition checks are typically used with PermissionModeChange or SessionStatusChange events, not ${event}`,
      severity: 'warning',
    });
  }
}
