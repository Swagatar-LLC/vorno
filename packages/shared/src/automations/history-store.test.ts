/**
 * Tests for history-store: append + compaction with two-tier retention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAutomationHistoryEntry, compactAutomationHistory } from './history-store.ts';
import { AUTOMATIONS_HISTORY_FILE } from './constants.ts';

function readHistory(dir: string): Array<{ id: string; ts: number; [k: string]: unknown }> {
  const path = join(dir, AUTOMATIONS_HISTORY_FILE);
  try {
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeEntry(id: string, ts: number) {
  return { id, ts, ok: true };
}

describe('history-store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'history-store-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================================================
  // appendAutomationHistoryEntry
  // ============================================================================

  describe('appendAutomationHistoryEntry', () => {
    it('should create file and append entry', async () => {
      await appendAutomationHistoryEntry(tempDir, makeEntry('a1', 1000));
      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe('a1');
    });

    it('should append multiple entries in order', async () => {
      for (let i = 0; i < 5; i++) {
        await appendAutomationHistoryEntry(tempDir, makeEntry('a1', i));
      }
      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(5);
      expect(entries.map(e => e.ts)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  // ============================================================================
  // compactAutomationHistory
  // ============================================================================

  describe('compactAutomationHistory', () => {
    it('should keep only last N entries per automation ID', async () => {
      const lines = Array.from({ length: 30 }, (_, i) =>
        JSON.stringify(makeEntry('a1', i))
      ).join('\n') + '\n';
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines);

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(20);
      // Should keep the newest 20 (ts 10..29)
      expect(entries[0]!.ts).toBe(10);
      expect(entries[19]!.ts).toBe(29);
    });

    it('should keep N-per-ID independently across multiple IDs', async () => {
      const lines: string[] = [];
      // 25 entries for a1, 25 entries for a2 — interleaved
      for (let i = 0; i < 25; i++) {
        lines.push(JSON.stringify(makeEntry('a1', i)));
        lines.push(JSON.stringify(makeEntry('a2', 100 + i)));
      }
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      const a1 = entries.filter(e => e.id === 'a1');
      const a2 = entries.filter(e => e.id === 'a2');
      expect(a1).toHaveLength(20);
      expect(a2).toHaveLength(20);
      // Oldest a1 entries (ts 0..4) should be dropped
      expect(a1[0]!.ts).toBe(5);
      // Oldest a2 entries (ts 100..104) should be dropped
      expect(a2[0]!.ts).toBe(105);
    });

    it('should enforce global cap after per-ID trimming', async () => {
      // 100 automations × 20 entries each = 2000 entries → should be capped to 1000
      const lines: string[] = [];
      for (let automationIdx = 0; automationIdx < 100; automationIdx++) {
        for (let i = 0; i < 20; i++) {
          lines.push(JSON.stringify(makeEntry(`auto-${automationIdx}`, automationIdx * 1000 + i)));
        }
      }
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(1000);
      // Should keep the last 1000 entries (from the later automations)
    });

    it('should preserve chronological order', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push(JSON.stringify(makeEntry('a1', i * 10)));
      }
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.ts).toBeGreaterThan(entries[i - 1]!.ts);
      }
    });

    it('should drop malformed JSON lines', async () => {
      const lines = [
        JSON.stringify(makeEntry('a1', 1)),
        'not-json{{{',
        JSON.stringify(makeEntry('a1', 2)),
        '',
        JSON.stringify(makeEntry('a1', 3)),
      ];
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(3);
    });

    it('should no-op when file does not exist', async () => {
      // Should not throw
      await compactAutomationHistory(tempDir, 20, 1000);
    });

    it('should no-op when already within limits', async () => {
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify(makeEntry('a1', i))
      ).join('\n') + '\n';
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines);

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(5);
    });
  });

  // ============================================================================
  // fork(PLAN-017): per-kind retention (id + kind)
  // ============================================================================

  describe('per-kind compaction retention', () => {
    it('keeps N dispatch AND N outcome records independently for one id', async () => {
      const lines: string[] = [];
      // 30 dispatch (no kind) + 30 outcome records for a1, interleaved by ts.
      for (let i = 0; i < 30; i++) {
        lines.push(JSON.stringify({ id: 'a1', ts: i * 2, ok: true }));
        lines.push(JSON.stringify({ id: 'a1', ts: i * 2 + 1, kind: 'outcome', ok: true, errorCount: 0 }));
      }
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      const dispatch = entries.filter(e => e.kind === undefined);
      const outcome = entries.filter(e => e.kind === 'outcome');
      // Each kind is capped at 20 independently — neither evicts the other.
      expect(dispatch).toHaveLength(20);
      expect(outcome).toHaveLength(20);
    });

    it('outcome/missed records never evict dispatch records below the cap', async () => {
      const lines: string[] = [];
      // 20 dispatch records + 40 outcome + 40 missed for a1.
      for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ id: 'a1', ts: i, ok: true }));
      for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ id: 'a1', ts: 100 + i, kind: 'outcome', ok: false, errorCount: 1 }));
      for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ id: 'a1', ts: 200 + i, kind: 'missed', ok: false, expectedTs: i }));
      writeFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), lines.join('\n') + '\n');

      await compactAutomationHistory(tempDir, 20, 1000);

      const entries = readHistory(tempDir);
      // All 20 dispatch records survive; outcome/missed trimmed to 20 each.
      expect(entries.filter(e => e.kind === undefined)).toHaveLength(20);
      expect(entries.filter(e => e.kind === 'outcome')).toHaveLength(20);
      expect(entries.filter(e => e.kind === 'missed')).toHaveLength(20);
    });
  });

  // ============================================================================
  // Concurrent appends (mutex)
  // ============================================================================

  describe('concurrent appends', () => {
    it('should not lose entries under concurrent writes', async () => {
      const promises: Promise<void>[] = [];
      const count = 20;
      for (let i = 0; i < count; i++) {
        promises.push(appendAutomationHistoryEntry(tempDir, makeEntry('a1', i)));
      }
      await Promise.all(promises);

      const entries = readHistory(tempDir);
      expect(entries).toHaveLength(count);
    });
  });
});
