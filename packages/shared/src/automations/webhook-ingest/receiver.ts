/**
 * Webhook receiver pipeline — HTTP-agnostic, unit-testable.
 *
 * fork(PLAN-014). The route adapter (apps/server) parses the URL + body and maps
 * the returned {@link WebhookResult} to an HTTP Response; ALL security and ingest
 * logic lives here so any host (standalone, embedded) reuses it verbatim.
 *
 * Pipeline order (matters — see the spec §2):
 *   1. resolve workspace              → 404 on miss
 *   2. hook by slug + enabled         → 404 (non-disclosure)
 *   3. constant-time token compare    → 404
 *   4. body cap                       → 413
 *   5. (HMAC — Phase 2)
 *   6. idempotency                    → 200 {duplicate:true}
 *   7. per-hook rate limit            → 429 + Retry-After
 *   8. append to durable queue, THEN respond 202; emit happens in the background
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '../../utils/debug.ts';
import type { AutomationMatcher, HookConfig } from '../types.ts';
import type { WebhookReceivedPayload } from '../event-bus.ts';
import {
  WEBHOOKS_PAYLOADS_DIR,
  WEBHOOK_DEFAULT_RATE_PER_MINUTE,
} from '../constants.ts';
import { verifyToken, withinBodyCap } from './verify.ts';
import { extractIdempotencyKey, WebhookDedupStore } from './dedup.ts';
import { WebhookRateGate } from './rate-gate.ts';
import { WebhookIngestQueue, type IngestQueueEntry } from './ingest-queue.ts';

const log = createLogger('webhook-receiver');

/** Deferred-retry backoffs for post-enqueue executor failures. */
const RETRY_BACKOFFS_MS = [30_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

/** Headers always forwarded to the payload (lowercased). */
const BASE_HEADER_ALLOWLIST = new Set(['content-type', 'user-agent']);

export interface ResolvedWorkspace {
  workspaceId: string;
  rootPath: string;
}

export interface WebhookReceiverDeps {
  /** id/slug → workspace, or null when unknown. */
  resolveWorkspace(nameOrId: string): ResolvedWorkspace | null;
  /** Read the WebhookReceived matchers for a workspace root. */
  loadHooks(rootPath: string): AutomationMatcher[];
  /** Deliver a verified, deduped, rate-admitted event. Rejects on executor failure. */
  onWebhookEvent(workspaceId: string, payload: WebhookReceivedPayload): Promise<void> | void;
  /** Clock injection for tests. */
  now?: () => number;
  /** Write the raw payload to a staging file (default true). */
  writePayloadFile?: boolean;
}

export interface WebhookRequest {
  workspace: string;
  hookSlug: string;
  token: string;
  /** Request headers with lowercased keys. */
  headers: Record<string, string>;
  rawBody: Uint8Array;
}

export type WebhookResult =
  | { status: 404 }
  | { status: 413 }
  | { status: 429; retryAfterSeconds: number }
  | { status: 200; body: { duplicate: true } }
  | { status: 202; body: { eventId: string } };

export interface WebhookReceiver {
  handle(req: WebhookRequest): Promise<WebhookResult>;
  /** Re-emit pending (crashed/failed) deliveries for the given workspaces. */
  drainPending(workspaces: ResolvedWorkspace[]): Promise<void>;
  /** Start a periodic retry of pending deliveries. */
  startRetryTimer(intervalMs?: number): void;
  dispose(): void;
}

export function createWebhookReceiver(deps: WebhookReceiverDeps): WebhookReceiver {
  const now = deps.now ?? Date.now;
  const writePayloadFile = deps.writePayloadFile ?? true;
  const rateGate = new WebhookRateGate(now);
  const dedupStores = new Map<string, WebhookDedupStore>();
  const queues = new Map<string, WebhookIngestQueue>();
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  function getDedup(rootPath: string): WebhookDedupStore {
    let store = dedupStores.get(rootPath);
    if (!store) {
      store = new WebhookDedupStore(rootPath, { now });
      dedupStores.set(rootPath, store);
    }
    return store;
  }

  function getQueue(rootPath: string): WebhookIngestQueue {
    let queue = queues.get(rootPath);
    if (!queue) {
      queue = new WebhookIngestQueue(rootPath);
      queues.set(rootPath, queue);
    }
    return queue;
  }

  function findHook(rootPath: string, slug: string): { matcher: AutomationMatcher; hook: HookConfig } | null {
    const matchers = deps.loadHooks(rootPath);
    for (const matcher of matchers) {
      if (matcher.hook?.slug === slug) {
        if (matcher.enabled === false) return null; // non-disclosure: treat as missing
        return { matcher, hook: matcher.hook };
      }
    }
    return null;
  }

  function allowlistHeaders(headers: Record<string, string>, hook: HookConfig): Record<string, string> {
    const allow = new Set(BASE_HEADER_ALLOWLIST);
    if (hook.idempotencyKey?.source === 'header') allow.add(hook.idempotencyKey.name.toLowerCase());
    if (hook.verification?.signatureHeader) allow.add(hook.verification.signatureHeader.toLowerCase());
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (allow.has(k.toLowerCase())) out[k.toLowerCase()] = v;
    }
    return out;
  }

  function stagePayloadFile(rootPath: string, eventId: string, hookSlug: string, rawBody: Uint8Array): string | undefined {
    if (!writePayloadFile) return undefined;
    try {
      const dir = join(rootPath, WEBHOOKS_PAYLOADS_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const digest = createHash('sha256').update(eventId).digest('hex').slice(0, 16);
      const filePath = join(dir, `${hookSlug}-${digest}.json`);
      writeFileSync(filePath, Buffer.from(rawBody), 'utf-8');
      return filePath;
    } catch (err) {
      log.warn(`[webhook-receiver] failed to stage payload file: ${err}`);
      return undefined;
    }
  }

  async function process(rootPath: string, entry: IngestQueueEntry): Promise<void> {
    const queue = getQueue(rootPath);
    try {
      await deps.onWebhookEvent(entry.workspaceId, entry.payload);
      queue.markComplete(entry.eventId, now());
    } catch (err) {
      const attempts = (entry.attempts ?? 0) + 1;
      const backoff = RETRY_BACKOFFS_MS[Math.min(attempts - 1, RETRY_BACKOFFS_MS.length - 1)]!;
      queue.update({ ...entry, attempts, nextAttemptAt: now() + backoff });
      log.warn(`[webhook-receiver] delivery ${entry.eventId} failed (attempt ${attempts}) — will retry: ${err}`);
    }
  }

  async function handle(req: WebhookRequest): Promise<WebhookResult> {
    // 1. workspace
    const ws = deps.resolveWorkspace(req.workspace);
    if (!ws) return { status: 404 };

    // 2. hook by slug (+ enabled)
    const found = findHook(ws.rootPath, req.hookSlug);
    if (!found) return { status: 404 };
    const { matcher, hook } = found;

    // 3. token (constant-time)
    if (!verifyToken(hook, req.token)) return { status: 404 };

    // 4. body cap
    if (!withinBodyCap(hook, req.rawBody.byteLength)) return { status: 413 };

    // 5. HMAC — Phase 2 (inert)

    // Parse JSON body (best-effort; matching only).
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(req.rawBody));
    } catch {
      parsedBody = undefined;
    }

    const hookId = matcher.id ?? hook.slug;
    const idempotencyKey = extractIdempotencyKey(hook, req.headers, req.rawBody, parsedBody);
    const eventId = `${hookId}:${idempotencyKey}`;

    // 6. idempotency
    const dedup = getDedup(ws.rootPath);
    if (dedup.has(eventId)) return { status: 200, body: { duplicate: true } };

    // 7. rate limit
    const rateKey = `${ws.workspaceId}:${hookId}`;
    const perMinute = hook.rateLimit?.perMinute ?? WEBHOOK_DEFAULT_RATE_PER_MINUTE;
    const decision = rateGate.check(rateKey, perMinute, hook.rateLimit?.burst ?? 0);
    if (!decision.allowed) return { status: 429, retryAfterSeconds: decision.retryAfterSeconds };

    // 8. record + stage + enqueue (durable), THEN respond; emit in background.
    dedup.record(eventId);
    const payloadPath = stagePayloadFile(ws.rootPath, eventId, hook.slug, req.rawBody);
    const payload: WebhookReceivedPayload = {
      workspaceId: ws.workspaceId,
      timestamp: now(),
      hookId,
      hookSlug: hook.slug,
      eventId,
      payloadPath,
      payloadCount: 1,
      headers: allowlistHeaders(req.headers, hook),
      body: parsedBody,
    };

    const entry: IngestQueueEntry = {
      eventId,
      workspaceId: ws.workspaceId,
      payload,
      createdAt: now(),
    };
    getQueue(ws.rootPath).append(entry);

    // Fire-and-forget: never make the provider wait on the executor.
    void process(ws.rootPath, entry);

    return { status: 202, body: { eventId } };
  }

  async function drainPending(workspaces: ResolvedWorkspace[]): Promise<void> {
    for (const ws of workspaces) {
      const queue = getQueue(ws.rootPath);
      const pending = queue.listPending();
      if (pending.length === 0) continue;
      log.debug(`[webhook-receiver] draining ${pending.length} pending deliveries for ${ws.workspaceId}`);
      queue.compact();
      for (const entry of pending) {
        await process(ws.rootPath, entry);
      }
    }
  }

  function startRetryTimer(intervalMs = 60_000): void {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      const currentNow = now();
      for (const [rootPath, queue] of queues) {
        for (const entry of queue.listPending()) {
          if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > currentNow) continue;
          void process(rootPath, entry);
        }
      }
    }, intervalMs);
    // Don't keep the process alive solely for the retry timer.
    (retryTimer as { unref?: () => void }).unref?.();
  }

  function dispose(): void {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  return { handle, drainPending, startRetryTimer, dispose };
}
