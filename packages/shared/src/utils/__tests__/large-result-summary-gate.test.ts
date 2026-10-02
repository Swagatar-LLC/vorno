import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { askLargeResultSummaryGate, handleLargeResponse, setLargeResultSummaryGate } from '../large-response.ts';

// ~20k tokens of plain text: above the default threshold.
const bigText = 'word '.repeat(80_000);

describe('large result summary gate', () => {
  let sessionPath: string;
  let summarized = 0;
  const summarize = async () => { summarized++; return 'mocked summary'; };

  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'summary-gate-'));
    summarized = 0;
  });

  afterEach(() => {
    setLargeResultSummaryGate(null);
    rmSync(sessionPath, { recursive: true, force: true });
  });

  const run = () => handleLargeResponse({ text: bigText, sessionPath, context: { toolName: 'search', intent: 'find the error' }, summarize });

  test('summarizes as before without a gate', async () => {
    expect((await run())?.wasSummarized).toBe(true);
    expect(summarized).toBe(1);
  });

  test('skips the summary when the gate says the preview is enough, keeping file and preview', async () => {
    const seen: string[] = [];
    setLargeResultSummaryGate(async ({ context, estimatedTokens }) => {
      seen.push(`${context.toolName}:${context.intent}:${estimatedTokens > 12_000}`);
      return false;
    });
    const result = await run();
    expect(seen).toEqual(['search:find the error:true']);
    expect(summarized).toBe(0);
    expect(result?.wasSummarized).toBe(false);
    expect(result?.message).toContain('word word');
    expect(result?.filePath).toBeTruthy();
  });

  test('summarizes when the gate has no answer or fails', async () => {
    setLargeResultSummaryGate(async () => null);
    expect((await run())?.wasSummarized).toBe(true);
    setLargeResultSummaryGate(async () => { throw new Error('down'); });
    expect((await run())?.wasSummarized).toBe(true);
    expect(summarized).toBe(2);
  });

  test('answers for another process (the Pi subprocess) with the installed gate', async () => {
    const input = { text: 'abc', context: { toolName: 'bash' }, estimatedTokens: 20_000 };
    expect(await askLargeResultSummaryGate(input)).toBeNull();
    setLargeResultSummaryGate(async () => false);
    expect(await askLargeResultSummaryGate(input)).toBe(false);
    setLargeResultSummaryGate(async () => { throw new Error('down'); });
    expect(await askLargeResultSummaryGate(input)).toBeNull();
  });
});
