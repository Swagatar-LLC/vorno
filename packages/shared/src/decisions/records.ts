/**
 * Decision layer — decision records.
 *
 * Every decision call appends one JSON line to `~/.craft-agent/logs/decisions.jsonl`
 * (same pattern as the pages action audit log). A record holds what is needed to
 * audit the decision — question types, pinned and reported model, probabilities,
 * latency, usage, failure kind and status — and NEVER the state text: only its
 * sha256 and byte count.
 *
 * Question keys, choice option keys and probability-map keys are agent-supplied
 * free text, so a record stores each one as a deterministic hash
 * (`hashDecisionIdentifier`): the same key always maps to the same id, so records
 * can still be grouped and compared, but the plaintext is not retained. Score
 * level indices ("0".."9") are kept as they are. Failures carry a fixed message
 * per kind (`toDecisionAuditFailure`), never provider text or the error message,
 * which names question keys. Caller-supplied `meta` keeps only finite numbers and
 * booleans under fixed operational key names.
 *
 * Writes are fire-and-forget: a failed append is logged and never fails the call.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import { createLogger } from '../utils/debug.ts';
import {
  toDecisionAuditFailure,
  type DecisionAnswer,
  type DecisionFailure,
  type DecisionProviderId,
  type DecisionQuestion,
  type DecisionQuestionType,
  type DecisionResult,
  type DecisionStateDigest,
  type DecisionUsage,
} from './types.ts';

const log = createLogger('decisions');

export const DEFAULT_DECISIONS_LOG_PATH = join(CONFIG_DIR, 'logs', 'decisions.jsonl');
/** When the log grows past this, it is renamed to `decisions.prev.jsonl` and restarted. */
export const DECISIONS_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Well-known feature tags; free-form strings are allowed for future callers. */
export type DecisionFeature = 'decide_tool' | 'settings_test' | 'task_verdict' | 'semantic_labels' | (string & {});

/** Numbers and hashed option keys only — never free text from the state or the questions. */
export interface DecisionRecordAnswer {
  type: DecisionQuestionType;
  choice?: string;
  confidence?: number;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
}

export interface DecisionRecord {
  /** ISO timestamp. */
  t: string;
  feature: DecisionFeature;
  provider: DecisionProviderId;
  /** Pinned model id that was requested. */
  model: string;
  /** Model id the server reported (invariant 4). Absent when the response did not name one. */
  responseModel?: string;
  ok: boolean;
  latencyMs?: number;
  /** Hashed question key → type. */
  questions: Record<string, DecisionQuestionType>;
  /** Digest only. `null` when the call failed before the state was prepared. */
  state: DecisionStateDigest | null;
  answers?: Record<string, DecisionRecordAnswer>;
  usage?: DecisionUsage;
  error?: DecisionFailure;
  sessionId?: string;
  /** Caller context (e.g. item count, thresholds): finite numbers and booleans only. */
  meta?: Record<string, number | boolean>;
}

export interface DecisionRecordInput {
  feature: DecisionFeature;
  provider: DecisionProviderId;
  model: string;
  questions: Record<string, DecisionQuestion>;
  result?: DecisionResult;
  /** Thrown value when the call failed. */
  error?: unknown;
  /** Only needed for failures; successes carry their own latency. */
  latencyMs?: number;
  sessionId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Deterministic hashed id for an agent-supplied identifier (question
 * key, choice option key). Equal inputs give equal ids across records.
 */
export function hashDecisionIdentifier(value: string): string {
  return `h_${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Score probabilities are keyed by level index; anything else is hashed. */
const SCORE_LEVEL_KEY = /^\d{1,2}$/;

function hashKeys(map: Record<string, number>, keep?: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) out[keep?.test(key) ? key : hashDecisionIdentifier(key)] = value;
  return out;
}

const META_KEYS = new Set(['batch', 'index', 'total', 'items', 'threshold']);

/** Keep finite numbers and booleans under fixed operational key names; drop everything else. */
export function sanitizeDecisionMeta(meta: Record<string, unknown>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEYS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

export function summarizeDecisionAnswers(answers: Record<string, DecisionAnswer>): Record<string, DecisionRecordAnswer> {
  const summary: Record<string, DecisionRecordAnswer> = {};
  for (const [key, answer] of Object.entries(answers)) {
    const id = hashDecisionIdentifier(key);
    switch (answer.type) {
      case 'choice':
        summary[id] = {
          type: 'choice',
          choice: hashDecisionIdentifier(answer.choice),
          confidence: answer.confidence,
          probabilities: hashKeys(answer.probabilities),
        };
        break;
      case 'score':
        summary[id] = { type: 'score', score: answer.score, confidence: answer.confidence, probabilities: hashKeys(answer.probabilities, SCORE_LEVEL_KEY) };
        break;
      case 'noul':
        summary[id] = { type: 'noul', noul: answer.noul };
        break;
    }
  }
  return summary;
}

export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const questions: Record<string, DecisionQuestionType> = {};
  for (const [key, question] of Object.entries(input.questions)) questions[hashDecisionIdentifier(key)] = question.type;

  const record: DecisionRecord = {
    t: new Date().toISOString(),
    feature: input.feature,
    provider: input.provider,
    model: input.model,
    ok: input.result !== undefined && input.error === undefined,
    questions,
    state: null,
  };

  if (input.result) {
    if (input.result.modelReported) record.responseModel = input.result.model;
    record.latencyMs = input.result.latencyMs;
    record.state = input.result.state;
    record.answers = summarizeDecisionAnswers(input.result.answers);
    record.usage = input.result.usage;
  }
  if (input.error !== undefined) {
    record.error = toDecisionAuditFailure(input.error);
    const digest = (input.error as { state?: DecisionStateDigest } | null)?.state;
    if (digest && !record.state) record.state = digest;
  }
  if (input.latencyMs !== undefined && record.latencyMs === undefined) record.latencyMs = input.latencyMs;
  if (input.sessionId) record.sessionId = input.sessionId;
  if (input.meta) {
    const meta = sanitizeDecisionMeta(input.meta);
    if (Object.keys(meta).length > 0) record.meta = meta;
  }

  return record;
}

export class DecisionRecorder {
  readonly path: string;
  private readonly maxBytes: number;
  /** Serialises rotate+append so concurrent calls cannot interleave. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options?: { path?: string; maxBytes?: number }) {
    this.path = options?.path ?? DEFAULT_DECISIONS_LOG_PATH;
    this.maxBytes = options?.maxBytes ?? DECISIONS_LOG_MAX_BYTES;
  }

  /** Build and append a record. Never throws. */
  async record(input: DecisionRecordInput): Promise<DecisionRecord> {
    const record = buildDecisionRecord(input);
    await this.append(record);
    return record;
  }

  /** Append a prebuilt record. Never throws. */
  async append(record: DecisionRecord): Promise<void> {
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await this.rotateIfNeeded();
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    });
    // Keep the chain alive even when one write fails.
    this.queue = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      log.warn(`Failed to write decision record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return; // no file yet
    }
    if (size <= this.maxBytes) return;
    const previous = this.path.endsWith('.jsonl') ? `${this.path.slice(0, -'.jsonl'.length)}.prev.jsonl` : `${this.path}.prev`;
    await rename(this.path, previous);
  }
}

let defaultRecorder: DecisionRecorder | null = null;

/** Process-wide recorder writing to the default log path. */
export function getDecisionRecorder(): DecisionRecorder {
  if (!defaultRecorder) defaultRecorder = new DecisionRecorder();
  return defaultRecorder;
}
