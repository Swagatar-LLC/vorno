import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_LEVEL,
  dailyLogFileName,
  formatLogLine,
  isLogLevel,
  localDateStamp,
  nextArchiveFileName,
  parseDailyLogFileName,
  pruneDailyLogs,
  resolveLogLevel,
} from '../file-log.ts';

describe('resolveLogLevel', () => {
  test('defaults to info when nothing is set', () => {
    expect(resolveLogLevel({}, () => DEFAULT_LOG_LEVEL)).toEqual({ level: 'info', envOverride: false });
  });

  test('uses the stored level when env is unset', () => {
    expect(resolveLogLevel({}, () => 'debug')).toEqual({ level: 'debug', envOverride: false });
    expect(resolveLogLevel({}, () => 'error')).toEqual({ level: 'error', envOverride: false });
  });

  test('CRAFT_LOG_LEVEL wins over the stored level', () => {
    expect(resolveLogLevel({ CRAFT_LOG_LEVEL: 'debug' }, () => 'error')).toEqual({
      level: 'debug',
      envOverride: true,
    });
  });

  test('env value is case-insensitive', () => {
    expect(resolveLogLevel({ CRAFT_LOG_LEVEL: 'WARN' }, () => 'info').level).toBe('warn');
  });

  test('invalid env value falls through to stored', () => {
    expect(resolveLogLevel({ CRAFT_LOG_LEVEL: 'verbose' }, () => 'warn')).toEqual({
      level: 'warn',
      envOverride: false,
    });
  });

  test('invalid stored value falls back to default', () => {
    expect(resolveLogLevel({}, () => 'silly' as never).level).toBe('info');
  });
});

describe('isLogLevel', () => {
  test('accepts the four user levels only', () => {
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('info')).toBe(true);
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('silly')).toBe(false);
    expect(isLogLevel('')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe('daily file naming', () => {
  test('dailyLogFileName embeds the local date', () => {
    const date = new Date(2026, 6, 9, 23, 59); // July 9 local
    expect(localDateStamp(date)).toBe('2026-07-09');
    expect(dailyLogFileName('main', date)).toBe('main-2026-07-09.log');
  });

  test('parseDailyLogFileName round-trips active and archive names', () => {
    expect(parseDailyLogFileName('main-2026-07-09.log')).toEqual({
      prefix: 'main',
      dateStamp: '2026-07-09',
      archiveIndex: 0,
    });
    expect(parseDailyLogFileName('main-2026-07-09.3.log')).toEqual({
      prefix: 'main',
      dateStamp: '2026-07-09',
      archiveIndex: 3,
    });
    expect(parseDailyLogFileName('auto-update.log')).toBeNull();
    expect(parseDailyLogFileName('messaging-gateway.log')).toBeNull();
    expect(parseDailyLogFileName('main.log')).toBeNull();
  });
});

describe('nextArchiveFileName / pruneDailyLogs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan015-logs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('first archive is .1, subsequent ones increment without clobbering', () => {
    expect(nextArchiveFileName(dir, 'main-2026-07-09.log')).toBe('main-2026-07-09.1.log');
    writeFileSync(join(dir, 'main-2026-07-09.1.log'), 'x');
    expect(nextArchiveFileName(dir, 'main-2026-07-09.log')).toBe('main-2026-07-09.2.log');
    writeFileSync(join(dir, 'main-2026-07-09.2.log'), 'x');
    expect(nextArchiveFileName(dir, 'main-2026-07-09.log')).toBe('main-2026-07-09.3.log');
  });

  test('prunes files older than maxAgeDays by embedded date, keeps the rest', () => {
    const now = new Date(2026, 6, 9); // 2026-07-09
    for (const name of [
      'main-2026-07-09.log',   // today — keep
      'main-2026-06-25.log',   // exactly 14 days — keep (strictly-older rule)
      'main-2026-06-24.log',   // 15 days — prune
      'main-2026-06-24.1.log', // archive of old day — prune
      'main-2026-01-01.log',   // ancient — prune
      'auto-update.log',       // different scheme — untouched
      'other-2026-01-01.log',  // different prefix — untouched
    ]) {
      writeFileSync(join(dir, name), 'x');
    }

    const deleted = pruneDailyLogs(dir, { prefix: 'main', maxAgeDays: 14, now });

    expect(deleted.sort()).toEqual([
      'main-2026-01-01.log',
      'main-2026-06-24.1.log',
      'main-2026-06-24.log',
    ]);
    expect(existsSync(join(dir, 'main-2026-07-09.log'))).toBe(true);
    expect(existsSync(join(dir, 'main-2026-06-25.log'))).toBe(true);
    expect(existsSync(join(dir, 'auto-update.log'))).toBe(true);
    expect(existsSync(join(dir, 'other-2026-01-01.log'))).toBe(true);
    expect(readdirSync(dir).length).toBe(4);
  });

  test('pruning a missing directory is a silent no-op', () => {
    expect(pruneDailyLogs(join(dir, 'nope'), { prefix: 'main', maxAgeDays: 14 })).toEqual([]);
  });
});

describe('formatLogLine', () => {
  test('emits ISO timestamp, padded level, scope, message', () => {
    const line = formatLogLine({
      date: new Date('2026-07-09T14:42:00.123Z'),
      level: 'info',
      scope: 'main',
      text: 'server started',
    });
    expect(line).toBe('2026-07-09T14:42:00.123Z INFO  [main] server started');
  });

  test('omits scope bracket when unscoped and flattens newlines', () => {
    const line = formatLogLine({
      date: new Date('2026-07-09T14:42:00.000Z'),
      level: 'error',
      text: 'boom\nstack line',
    });
    expect(line).toBe('2026-07-09T14:42:00.000Z ERROR boom\\nstack line');
    expect(line.includes('\n')).toBe(false);
  });
});
