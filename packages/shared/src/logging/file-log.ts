/**
 * fork(PLAN-015): production file-logging helpers.
 *
 * Pure, dependency-light functions shared by the Electron main-process logger
 * (apps/electron/src/main/logger.ts) and available to any future consumer
 * (e.g. the standalone apps/server if it ever adopts file logging). Kept in
 * packages/shared so they run under the CI shared test suite.
 *
 * Naming scheme: `<prefix>-YYYY-MM-DD.log` for the active daily file, with
 * `<prefix>-YYYY-MM-DD.N.log` (N >= 1) for size-cap archives of the same day.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Levels exposed to users. Subset of electron-log's levels, identical names. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Env var that force-overrides the stored log level (support/debug escape hatch). */
export const LOG_LEVEL_ENV_VAR = 'CRAFT_LOG_LEVEL';

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LogLevelState {
  level: LogLevel;
  /** True when CRAFT_LOG_LEVEL forced the value (UI disables the selector). */
  envOverride: boolean;
}

/**
 * Resolve the effective log level: explicit env var wins; otherwise the stored
 * setting; invalid values fall back to the default. Mirrors the resolution
 * pattern established by PLAN-011's keep-alive setting.
 */
export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
  readStored: () => LogLevel = () => DEFAULT_LOG_LEVEL,
): LogLevelState {
  const raw = env[LOG_LEVEL_ENV_VAR]?.toLowerCase();
  if (isLogLevel(raw)) return { level: raw, envOverride: true };
  const stored = readStored();
  return { level: isLogLevel(stored) ? stored : DEFAULT_LOG_LEVEL, envOverride: false };
}

/** `2026-07-09` for a local-time date (log days follow the user's clock). */
export function localDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Active daily file name, e.g. `main-2026-07-09.log`. */
export function dailyLogFileName(prefix: string, date: Date): string {
  return `${prefix}-${localDateStamp(date)}.log`;
}

const DAILY_LOG_RE = /^(.+)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

export interface ParsedLogFileName {
  prefix: string;
  /** YYYY-MM-DD date stamp embedded in the name. */
  dateStamp: string;
  /** Size-cap archive index; 0 for the active daily file. */
  archiveIndex: number;
}

/** Parse `<prefix>-YYYY-MM-DD[.N].log`; null for anything else. */
export function parseDailyLogFileName(fileName: string): ParsedLogFileName | null {
  const m = DAILY_LOG_RE.exec(fileName);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { prefix: m[1], dateStamp: m[2], archiveIndex: m[3] ? Number(m[3]) : 0 };
}

/**
 * Next free archive name for a daily file that hit the size cap:
 * `main-2026-07-09.log` -> `main-2026-07-09.1.log` (then `.2`, ...).
 * Existing archives are never overwritten.
 */
export function nextArchiveFileName(dir: string, activeFileName: string): string {
  const base = activeFileName.replace(/\.log$/, '');
  let index = 1;
  while (existsSync(join(dir, `${base}.${index}.log`))) index += 1;
  return `${base}.${index}.log`;
}

export interface PruneOptions {
  /** Only files with this prefix are considered (never touches other logs). */
  prefix: string;
  /** Files whose embedded date is strictly older than this many days are removed. */
  maxAgeDays: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Delete daily log files older than `maxAgeDays`, judged by the date embedded
 * in the file name (deterministic; mtime is irrelevant). Returns deleted names.
 * Never throws — pruning is best-effort housekeeping.
 */
export function pruneDailyLogs(dir: string, opts: PruneOptions): string[] {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - opts.maxAgeDays);

  const deleted: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return deleted;
  }
  for (const name of entries) {
    const parsed = parseDailyLogFileName(name);
    if (!parsed || parsed.prefix !== opts.prefix) continue;
    const [y = NaN, m = NaN, d = NaN] = parsed.dateStamp.split('-').map(Number);
    const fileDate = new Date(y, m - 1, d);
    if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) continue;
    try {
      rmSync(join(dir, name), { force: true });
      deleted.push(name);
    } catch {
      // best-effort; a locked file just survives until the next prune
    }
  }
  return deleted;
}

export interface LogLineParts {
  date: Date;
  level: string;
  scope?: string;
  text: string;
}

/**
 * Single plain-text line: `2026-07-09T14:42:00.123Z INFO  [scope] message`.
 * Level is padded to 5 so columns align for grep/lnav; embedded newlines are
 * escaped so one log call is always exactly one line.
 */
export function formatLogLine({ date, level, scope, text }: LogLineParts): string {
  const lvl = level.toUpperCase().padEnd(5);
  const scopePart = scope ? ` [${scope}]` : '';
  const flat = text.replace(/\r?\n/g, '\\n');
  return `${date.toISOString()} ${lvl}${scopePart} ${flat}`;
}
