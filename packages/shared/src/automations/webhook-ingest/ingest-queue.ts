/**
 * Durable ingest queue — append-before-202, tombstone-on-complete.
 *
 * fork(PLAN-014). Every admitted delivery is appended to
 * `{workspaceRoot}/webhooks-ingest.jsonl` BEFORE the 202 is returned. When the
 * downstream emit/executor settles successfully, a tombstone line is appended.
 * A crash between append and tombstone leaves the entry pending, so the startup
 * drain (and the periodic retry timer) re-emit it — this is the durability that
 * lets a provider stop retrying the moment we return 2xx.
 *
 * The file is line-oriented and append-only on the hot path; compaction rewrites
 * it to drop completed pairs.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEBHOOKS_INGEST_FILE } from '../constants.ts';
import type { WebhookReceivedPayload } from '../event-bus.ts';

export interface IngestQueueEntry {
  eventId: string;
  workspaceId: string;
  payload: WebhookReceivedPayload;
  createdAt: number;
  /** Deferred-retry attempts already made (for backoff bookkeeping). */
  attempts?: number;
  /** Earliest time (ms) this entry should be retried. */
  nextAttemptAt?: number;
}

interface Tombstone {
  eventId: string;
  done: true;
  ts: number;
}

type Line = IngestQueueEntry | Tombstone;

function isTombstone(line: Line): line is Tombstone {
  return (line as Tombstone).done === true;
}

export class WebhookIngestQueue {
  private readonly filePath: string;

  constructor(workspaceRootPath: string) {
    this.filePath = join(workspaceRootPath, WEBHOOKS_INGEST_FILE);
  }

  /** Append an accepted delivery. Fast, synchronous — runs before the 202. */
  append(entry: IngestQueueEntry): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /** Mark a delivery as fully processed (tombstone). */
  markComplete(eventId: string, now: number = Date.now()): void {
    const tombstone: Tombstone = { eventId, done: true, ts: now };
    try {
      appendFileSync(this.filePath, JSON.stringify(tombstone) + '\n', 'utf-8');
    } catch {
      // Non-fatal — a redundant re-emit on next drain is idempotent (dedup guards it).
    }
  }

  /** Return entries that have no matching tombstone (latest entry per eventId). */
  listPending(): IngestQueueEntry[] {
    const lines = this.readLines();
    const tombstoned = new Set<string>();
    for (const line of lines) {
      if (isTombstone(line)) tombstoned.add(line.eventId);
    }
    const pending = new Map<string, IngestQueueEntry>();
    for (const line of lines) {
      if (isTombstone(line)) continue;
      if (tombstoned.has(line.eventId)) continue;
      pending.set(line.eventId, line);
    }
    return [...pending.values()];
  }

  /** Persist an updated entry (e.g. bumped attempt count) by appending it. */
  update(entry: IngestQueueEntry): void {
    this.append(entry);
  }

  /** Rewrite the file, dropping completed pairs. Safe at startup. */
  compact(): void {
    const pending = this.listPending();
    try {
      writeFileSync(
        this.filePath,
        pending.length ? pending.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
        'utf-8',
      );
    } catch {
      // Non-fatal.
    }
  }

  private readLines(): Line[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    const out: Line[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Line);
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  }
}
