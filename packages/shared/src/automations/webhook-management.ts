/**
 * fork(PLAN-014) Phase 3 — webhook management over a workspace's automations.json.
 *
 * Host-agnostic (no Electron / no server-core / no HTTP dependency): the Electron
 * main `craft-fork:webhooks:*` handlers and any future host call these. A webhook
 * is a `WebhookReceived` automation matcher, so management is expressed as CRUD
 * over that event's matcher array.
 *
 * Single-writer discipline (Risk #5):
 *   - all mutations serialize through a per-workspace-root mutex;
 *   - the whole config is re-validated (Zod + semantic) after mutation and
 *     REJECTED on any error — a bad edit never reaches disk;
 *   - writes are atomic via `.tmp` + rename.
 *
 * Secret discipline: token plaintext is generated here and returned to the caller
 * exactly once (create / rotate). Only `tokenHash` + `tokenPrefix` are persisted.
 * REVOKE(clear) strips both — a hook with no `tokenHash` cannot be invoked.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PermissionMode } from '../agent/mode-types.ts';
import type { AutomationAction, AutomationMatcher } from './types.ts';
import { validateAutomationsConfig } from './validation.ts';
import { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';
import { AUTOMATIONS_HISTORY_FILE, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER } from './constants.ts';
import { join } from 'node:path';
import { generateHookToken } from './webhook-ingest/tokens.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Read-model of one registered webhook (never carries the token plaintext). */
export interface WebhookSummary {
  /** Matcher id — stable handle for edit/revoke/deliveries. */
  id: string;
  name: string;
  slug: string;
  /** `false` only when the matcher is explicitly disabled. */
  enabled: boolean;
  labels: string[];
  permissionMode?: PermissionMode;
  /** Regex matched against `matchField` (or the whole body). */
  matcher?: string;
  matchField?: string;
  /** Whether a usable token is currently minted. */
  hasToken: boolean;
  /** Display-only token prefix (e.g. `craft_whk_...f3a`); never the full token. */
  tokenPrefix?: string;
  /** Action type list for at-a-glance display (e.g. `['prompt']`). */
  actionTypes: string[];
  /** Full action set (for editing round-trips). */
  actions: AutomationAction[];
  /** Ingest path WITHOUT host or token: `/hooks/{workspace}/{slug}`. */
  ingestPath: string;
}

/** Create / edit payload. `id` present + found → edit; otherwise → create. */
export interface WebhookUpsertInput {
  id?: string;
  name: string;
  slug: string;
  matcher?: string;
  matchField?: string;
  permissionMode?: PermissionMode;
  labels?: string[];
  enabled?: boolean;
  /** Defaults to a single starter prompt action on create. */
  actions?: AutomationAction[];
}

export interface WebhookUpsertResult {
  webhook: WebhookSummary;
  /** Plaintext token — present only when a new hook was created and minted. */
  token?: string;
}

export type WebhookRevokeAction = 'rotate' | 'clear';

export interface WebhookRevokeResult {
  webhook: WebhookSummary;
  /** Plaintext token — present only for `rotate`. */
  token?: string;
}

/** One delivery/execution record for a hook (from automations-history.jsonl). */
export interface WebhookDelivery {
  ts: number;
  ok: boolean;
  kind: 'prompt' | 'session-action' | 'webhook' | 'unknown';
  sessionId?: string;
  /** session-action outcome, e.g. `set-status:needs-review`, `deferred:...`. */
  outcome?: string;
  actionType?: string;
  eventId?: string;
  error?: string;
  /** Truncated prompt text for prompt deliveries. */
  prompt?: string;
}

const DEFAULT_WEBHOOK_ACTIONS: AutomationAction[] = [
  {
    type: 'prompt',
    prompt: 'Handle this webhook delivery. Payload: $CRAFT_WEBHOOK_PAYLOAD_PATH',
  },
];

// ---------------------------------------------------------------------------
// Single-writer machinery
// ---------------------------------------------------------------------------

interface RawConfig {
  automations?: Record<string, Record<string, unknown>[]>;
  [key: string]: unknown;
}

const configMutexes = new Map<string, Promise<unknown>>();

/** Serialize read-modify-write cycles per workspace root. */
function withConfigMutex<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = configMutexes.get(workspaceRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  configMutexes.set(workspaceRoot, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

function readRawConfig(configPath: string): RawConfig {
  if (!existsSync(configPath)) return { automations: {} };
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as RawConfig;
  if (!parsed.automations) parsed.automations = {};
  return parsed;
}

/**
 * Mutate the WebhookReceived matcher array under the mutex, validate the whole
 * config, and atomically persist it. `mutate` returns the value handed back to
 * the caller. Throws (leaving disk untouched) when the result fails validation.
 */
async function withWebhookMatchers<T>(
  workspaceRoot: string,
  mutate: (matchers: Record<string, unknown>[], config: RawConfig) => T,
): Promise<T> {
  return withConfigMutex(workspaceRoot, async () => {
    const configPath = resolveAutomationsConfigPath(workspaceRoot);
    const config = readRawConfig(configPath);
    const automations = config.automations as Record<string, Record<string, unknown>[]>;
    if (!Array.isArray(automations.WebhookReceived)) automations.WebhookReceived = [];

    const result = mutate(automations.WebhookReceived, config);

    // Drop an emptied event key so the file stays tidy (mirrors DELETE handler).
    if (automations.WebhookReceived.length === 0) delete automations.WebhookReceived;

    const validation = validateAutomationsConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid automations config after webhook edit: ${validation.errors.join('; ')}`);
    }

    const tmpPath = `${configPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, configPath);

    return result;
  });
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSummary(matcher: AutomationMatcher, workspaceName: string): WebhookSummary {
  const hook = matcher.hook;
  const slug = hook?.slug ?? '';
  const actions = matcher.actions ?? [];
  return {
    id: matcher.id ?? '',
    name: matcher.name ?? slug ?? 'Untitled webhook',
    slug,
    enabled: matcher.enabled !== false,
    labels: matcher.labels ?? [],
    permissionMode: matcher.permissionMode,
    matcher: matcher.matcher,
    matchField: matcher.matchField,
    hasToken: Boolean(hook?.tokenHash),
    tokenPrefix: hook?.tokenPrefix,
    actionTypes: actions.map((a) => a.type),
    actions,
    ingestPath: `/hooks/${workspaceName}/${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** List all registered webhooks for a workspace (read-only, no mutation). */
export function listWebhooks(workspaceRoot: string, workspaceName: string): WebhookSummary[] {
  const configPath = resolveAutomationsConfigPath(workspaceRoot);
  const config = readRawConfig(configPath);
  const matchers = (config.automations?.WebhookReceived ?? []) as unknown as AutomationMatcher[];
  return matchers.map((m) => toSummary(m, workspaceName));
}

/**
 * Create or edit a webhook. Creating mints a token and returns its plaintext
 * exactly once; editing preserves the existing token untouched.
 */
export async function upsertWebhook(
  workspaceRoot: string,
  workspaceName: string,
  input: WebhookUpsertInput,
): Promise<WebhookUpsertResult> {
  const applyFields = (matcher: Record<string, unknown>) => {
    matcher.name = input.name;
    matcher.matcher = input.matcher; // undefined clears it — valid for WebhookReceived
    if (input.matchField !== undefined) matcher.matchField = input.matchField;
    else delete matcher.matchField;
    if (input.permissionMode !== undefined) matcher.permissionMode = input.permissionMode;
    else delete matcher.permissionMode;
    if (input.labels !== undefined) matcher.labels = input.labels;
    // enabled: false persists as an explicit flag; enabled=true clears the key.
    if (input.enabled === false) matcher.enabled = false;
    else delete matcher.enabled;
    if (input.actions !== undefined) matcher.actions = input.actions;
  };

  const { summaryMatcher, token } = await withWebhookMatchers(workspaceRoot, (matchers) => {
    const existing = input.id ? matchers.find((m) => m.id === input.id) : undefined;

    if (existing) {
      const hook = (existing.hook ?? {}) as Record<string, unknown>;
      hook.slug = input.slug;
      existing.hook = hook;
      applyFields(existing);
      return { summaryMatcher: existing as unknown as AutomationMatcher, token: undefined as string | undefined };
    }

    // Create: mint the first token so the hook is immediately invocable.
    const minted = generateHookToken();
    const matcher: Record<string, unknown> = {
      id: generateShortId(),
      hook: { slug: input.slug, tokenHash: minted.tokenHash, tokenPrefix: minted.tokenPrefix },
      actions: input.actions ?? DEFAULT_WEBHOOK_ACTIONS,
    };
    applyFields(matcher);
    matchers.push(matcher);
    return { summaryMatcher: matcher as unknown as AutomationMatcher, token: minted.token };
  });

  return { webhook: toSummary(summaryMatcher, workspaceName), token };
}

/**
 * Rotate or clear a hook's token. `rotate` mints a fresh token (invalidating the
 * old URL) and returns its plaintext once. `clear` strips the token entirely —
 * the hook stays registered but every ingest call 404s until re-minted.
 */
export async function revokeWebhookToken(
  workspaceRoot: string,
  workspaceName: string,
  id: string,
  action: WebhookRevokeAction,
): Promise<WebhookRevokeResult> {
  const { summaryMatcher, token } = await withWebhookMatchers(workspaceRoot, (matchers) => {
    const matcher = matchers.find((m) => m.id === id);
    if (!matcher) throw new Error(`Webhook not found: ${id}`);
    const hook = (matcher.hook ?? {}) as Record<string, unknown>;
    matcher.hook = hook;

    if (action === 'rotate') {
      const minted = generateHookToken();
      hook.tokenHash = minted.tokenHash;
      hook.tokenPrefix = minted.tokenPrefix;
      return { summaryMatcher: matcher as unknown as AutomationMatcher, token: minted.token as string | undefined };
    }

    // clear
    delete hook.tokenHash;
    delete hook.tokenPrefix;
    return { summaryMatcher: matcher as unknown as AutomationMatcher, token: undefined as string | undefined };
  });

  return { webhook: toSummary(summaryMatcher, workspaceName), token };
}

/**
 * Read delivery/execution records for a hook from automations-history.jsonl,
 * most-recent-first. Records are keyed by the matcher id (same envelope the
 * standalone executors and TEST/REPLAY handlers write).
 */
export async function readWebhookDeliveries(
  workspaceRoot: string,
  hookId: string,
  limit: number = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER,
): Promise<WebhookDelivery[]> {
  const clamped = Math.max(1, Math.min(limit, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER));
  const historyPath = join(workspaceRoot, AUTOMATIONS_HISTORY_FILE);
  let content: string;
  try {
    content = await readFile(historyPath, 'utf-8');
  } catch {
    return [];
  }

  const rows = content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null && e.id === hookId);

  return rows
    .slice(-clamped)
    .reverse()
    .map((e) => mapDelivery(e));
}

function mapDelivery(e: Record<string, unknown>): WebhookDelivery {
  const ts = typeof e.ts === 'number' ? e.ts : 0;
  const ok = Boolean(e.ok);
  const base: WebhookDelivery = { ts, ok, kind: 'unknown' };
  if (typeof e.error === 'string') base.error = e.error;

  const sessionAction = e.sessionAction as { type?: string; outcome?: string; eventId?: string } | undefined;
  if (sessionAction) {
    base.kind = 'session-action';
    base.actionType = sessionAction.type;
    base.outcome = sessionAction.outcome;
    base.eventId = sessionAction.eventId;
    return base;
  }
  if (e.webhook) {
    base.kind = 'webhook';
    return base;
  }
  // Prompt envelope: has sessionId and/or prompt.
  base.kind = 'prompt';
  if (typeof e.sessionId === 'string') base.sessionId = e.sessionId;
  if (typeof e.prompt === 'string') base.prompt = e.prompt;
  return base;
}
