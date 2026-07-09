/**
 * Idempotency — key extraction ladder + durable dedup store.
 *
 * fork(PLAN-014). Extraction ladder (per the spec):
 *   1. configured header (e.g. X-GitHub-Delivery, Stripe `id`)
 *   2. configured JSONPath-lite into the body
 *   3. fallback SHA-256 of the raw body (content-level dedup)
 *
 * Store: `{workspaceRoot}/webhooks-dedup.jsonl` with a 24h TTL. In-memory Map on
 * the hot path; JSONL for restart survival. Compacted (expired entries dropped)
 * on load and periodically as it grows.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEBHOOKS_DEDUP_FILE, WEBHOOK_DEDUP_TTL_MS } from '../constants.ts';
import type { HookConfig } from '../types.ts';
import { resolveJsonPathLiteString } from './jsonpath-lite.ts';

/**
 * Extract the idempotency key for a delivery. `headers` must be lowercased.
 * Returns a non-empty string (falls back to a content hash).
 */
export function extractIdempotencyKey(
  hook: HookConfig,
  headers: Record<string, string>,
  rawBody: Uint8Array,
  parsedBody: unknown,
): string {
  const spec = hook.idempotencyKey;
  if (spec) {
    if (spec.source === 'header') {
      const value = headers[spec.name.toLowerCase()];
      if (value) return value;
    } else if (spec.source === 'body') {
      const value = resolveJsonPathLiteString(parsedBody, spec.name);
      if (value) return value;
    }
  }
  // Fallback: content-level dedup via raw-body hash.
  return `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

interface DedupLine {
  eventId: string;
  ts: number;
}

export class WebhookDedupStore {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>(); // eventId -> recordedAt
  private appendsSinceCompaction = 0;

  constructor(workspaceRootPath: string, opts?: { ttlMs?: number; now?: () => number }) {
    this.filePath = join(workspaceRootPath, WEBHOOKS_DEDUP_FILE);
    this.ttlMs = opts?.ttlMs ?? WEBHOOK_DEDUP_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.load();
  }

  /** True when this eventId was already recorded within the TTL. */
  has(eventId: string): boolean {
    const recordedAt = this.seen.get(eventId);
    if (recordedAt === undefined) return false;
    if (this.now() - recordedAt > this.ttlMs) {
      this.seen.delete(eventId);
      return false;
    }
    return true;
  }

  /** Record an eventId as seen (in memory + JSONL). */
  record(eventId: string): void {
    const ts = this.now();
    this.seen.set(eventId, ts);
    try {
      appendFileSync(this.filePath, JSON.stringify({ eventId, ts } satisfies DedupLine) + '\n', 'utf-8');
    } catch {
      // Non-fatal — in-memory dedup still holds for this process lifetime.
    }
    if (++this.appendsSinceCompaction >= 500) this.compact();
  }

  /** Load prior entries, dropping expired ones. */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    let expiredSeen = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as DedupLine;
        if (typeof parsed.eventId !== 'string' || typeof parsed.ts !== 'number') continue;
        if (parsed.ts <= cutoff) {
          expiredSeen = true;
          continue;
        }
        this.seen.set(parsed.eventId, parsed.ts);
      } catch {
        expiredSeen = true; // malformed → rewrite drops it
      }
    }
    if (expiredSeen) this.compact();
  }

  /** Rewrite the JSONL with only live (unexpired) entries. */
  private compact(): void {
    const cutoff = this.now() - this.ttlMs;
    const lines: string[] = [];
    for (const [eventId, ts] of this.seen) {
      if (ts > cutoff) lines.push(JSON.stringify({ eventId, ts } satisfies DedupLine));
      else this.seen.delete(eventId);
    }
    try {
      writeFileSync(this.filePath, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
    } catch {
      // Non-fatal.
    }
    this.appendsSinceCompaction = 0;
  }
}
