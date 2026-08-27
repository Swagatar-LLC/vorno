/**
 * Benchmark harness logic (fork: PLAN-040 / SUV-0025).
 *
 * Everything under test here is pure: workload parsing, engine attribution,
 * fidelity classification, and aggregation. The parts that cannot be pure — a
 * live proxy, a real adapter, wall-clock latency — live in
 * `scripts/benchmark-headroom.ts` and are exercised by running it.
 *
 * The rule these tests exist to defend is the plan's: **measured or absent,
 * never interpolated.** An aggregate must never turn a payload whose stats were
 * unavailable into a zero, and must always carry its own denominator.
 */

import { describe, expect, it } from 'bun:test';
import { headroomMeasured, headroomUnavailable } from '@craft-agent/core/types';
import type { HeadroomCompressStats, HeadroomMeasurement } from '@craft-agent/core/types';
import {
  aggregateByEngine,
  aggregateLatency,
  deviations,
  normalizeEngineLabel,
  parseSessionTranscript,
  parseWorkflowRun,
  renderReportMarkdown,
  type PayloadMeasurement,
} from '../benchmark.ts';

// ---------------------------------------------------------------------------
// Engine attribution
// ---------------------------------------------------------------------------

describe('normalizeEngineLabel', () => {
  it('strips a trailing numeric ratio segment', () => {
    expect(normalizeEngineLabel('router:mixed:0.64')).toBe('router:mixed');
    expect(normalizeEngineLabel('router:text:0.02')).toBe('router:text');
    expect(normalizeEngineLabel('router:kompress:0.73')).toBe('router:kompress');
  });

  it('keeps a trailing segment that is not a number', () => {
    // `router:protected:system_message` names a *reason*, not a ratio. Dropping
    // it would merge two distinct engine outcomes into one row.
    expect(normalizeEngineLabel('router:protected:system_message')).toBe(
      'router:protected:system_message',
    );
    expect(normalizeEngineLabel('router:noop')).toBe('router:noop');
  });

  it('leaves a bare label alone', () => {
    expect(normalizeEngineLabel('kompress')).toBe('kompress');
  });
});

// ---------------------------------------------------------------------------
// Workload parsing
// ---------------------------------------------------------------------------

describe('parseSessionTranscript', () => {
  const lines = [
    JSON.stringify({ id: 's1', name: 'header record, not a message' }),
    JSON.stringify({ id: 'm1', type: 'user', content: 'find every handler' }),
    JSON.stringify({
      id: 'm2',
      type: 'tool',
      toolName: 'Grep',
      toolUseId: 'toolu_1',
      content: 'a'.repeat(4096),
    }),
    JSON.stringify({ id: 'm3', type: 'assistant', content: 'here they are' }),
    JSON.stringify({ id: 'm4', type: 'info', content: 'Response interrupted' }),
    JSON.stringify({
      id: 'm5',
      type: 'tool',
      toolName: 'Read',
      toolUseId: 'toolu_2',
      content: 'short',
    }),
    'not json at all',
  ];

  it('takes tool results above the size floor as payloads', () => {
    const w = parseSessionTranscript('sess-1', '/tmp/session.jsonl', lines, {
      minPayloadBytes: 1024,
    });

    expect(w.kind).toBe('session-transcript');
    expect(w.payloads.map((p) => p.id)).toEqual(['toolu_1']);
    expect(w.payloads[0]!.toolName).toBe('Grep');
    expect(w.payloads[0]!.toolCallId).toBe('toolu_1');
    expect(w.payloads[0]!.content.length).toBe(4096);
  });

  it('keeps the preceding conversation as history, in order', () => {
    const w = parseSessionTranscript('sess-1', '/tmp/session.jsonl', lines, {
      minPayloadBytes: 1024,
    });

    // The router's decisions depend on what came before — a tool result is
    // "recent" in a one-message conversation and not in a long one, and it
    // compresses differently. History is therefore part of the workload.
    expect(w.history.map((m) => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(w.history[0]!.content).toBe('find every handler');
  });

  it('skips unparseable lines and non-message record types without throwing', () => {
    const w = parseSessionTranscript('sess-1', '/tmp/session.jsonl', lines, {
      minPayloadBytes: 1024,
    });
    expect(w.history.some((m) => m.content === 'Response interrupted')).toBe(false);
  });

  it('reads a tool payload from `toolResult`, not from the display `content`', () => {
    // Current transcripts put a short UI line in `content` ("Read 412 lines")
    // and the payload that actually entered context in `toolResult`. Reading
    // `content` measures the label instead of the workload.
    const w = parseSessionTranscript(
      'sess-2',
      '/tmp/session.jsonl',
      [
        JSON.stringify({
          id: 'm1',
          type: 'tool',
          toolName: 'Read',
          toolUseId: 'toolu_9',
          content: 'Read 412 lines',
          toolResult: 'R'.repeat(9000),
        }),
      ],
      { minPayloadBytes: 1024 },
    );

    expect(w.payloads).toHaveLength(1);
    expect(w.payloads[0]!.content.length).toBe(9000);
    expect(w.history[0]!.content.length).toBe(9000);
  });

  it('falls back to `content` on older transcripts that carry no `toolResult`', () => {
    const w = parseSessionTranscript(
      'sess-3',
      '/tmp/session.jsonl',
      [
        JSON.stringify({
          id: 'm1',
          type: 'tool',
          toolName: 'Grep',
          toolUseId: 'toolu_8',
          content: 'C'.repeat(4096),
        }),
      ],
      { minPayloadBytes: 1024 },
    );

    expect(w.payloads).toHaveLength(1);
    expect(w.payloads[0]!.content.length).toBe(4096);
  });

  it('reports an empty workload rather than throwing on an empty file', () => {
    const w = parseSessionTranscript('sess-1', '/tmp/session.jsonl', [], {
      minPayloadBytes: 1024,
    });
    expect(w.payloads).toHaveLength(0);
    expect(w.history).toHaveLength(0);
  });
});

describe('parseWorkflowRun', () => {
  it('takes each node output above the floor as a payload', () => {
    const w = parseWorkflowRun(
      'run-1',
      '/tmp/run',
      [
        { id: 'orient', text: 'x'.repeat(3000) },
        { id: 'implement', text: 'tiny' },
        { id: 'verify', text: 'y'.repeat(3000) },
      ],
      { minPayloadBytes: 1024 },
    );

    expect(w.kind).toBe('workflow-run');
    expect(w.payloads.map((p) => p.id)).toEqual(['orient', 'verify']);
    // Conductor compresses a node output as a lone assistant message
    // (TaskRunner.compressOutput), so there is no history to carry.
    expect(w.history).toHaveLength(0);
  });

  it('preserves the caller\'s node order rather than ranking by size', () => {
    // The harness samples with `payloads.slice(0, --max-payloads)`, so whatever
    // order this function returns *is* the sampling rule. The caller hands nodes
    // over in filename order; if this ever sorted by size instead, the benchmark
    // would silently measure the biggest nodes while the report described a
    // filename-ordered prefix. The first published report claimed exactly that
    // ("the 12 largest were sampled") and was wrong — this test is what makes
    // the claim checkable instead of a matter of belief.
    const w = parseWorkflowRun(
      'run-1',
      '/tmp/run',
      [
        { id: 'a-small', text: 'x'.repeat(2100) },
        { id: 'b-huge', text: 'y'.repeat(90000) },
        { id: 'c-medium', text: 'z'.repeat(5000) },
      ],
      { minPayloadBytes: 2048 },
    );

    expect(w.payloads.map((p) => p.id)).toEqual(['a-small', 'b-huge', 'c-medium']);
    // Stated the other way round, so a size-ranking implementation cannot pass
    // by coincidence of the fixture's ordering.
    expect(w.payloads[0]!.id).not.toBe('b-huge');
  });
});

// ---------------------------------------------------------------------------
// Aggregation — the "measured or absent" rule
// ---------------------------------------------------------------------------

function stats(
  before: number,
  after: number,
  transforms: readonly string[],
): HeadroomMeasurement<HeadroomCompressStats> {
  return headroomMeasured({
    tokensBefore: before,
    tokensAfter: after,
    tokensSaved: before - after,
    compressionRatio: before === 0 ? 1 : after / before,
    transformsApplied: transforms,
  });
}

function measurement(over: Partial<PayloadMeasurement>): PayloadMeasurement {
  return {
    payloadId: 'p',
    workloadId: 'w',
    kind: 'session-tool-output',
    callSite: 'session-loop',
    bytesBefore: 100,
    accepted: true,
    stats: stats(1000, 400, ['router:text:0.40']),
    latencyMs: 10,
    baselineLatencyMs: 1,
    fidelity: { kind: 'round-trip-identical', handle: 'h1' },
    ...over,
  };
}

describe('aggregateByEngine', () => {
  it('groups by normalized engine and carries its own denominator', () => {
    const rows = aggregateByEngine([
      measurement({ payloadId: 'a', stats: stats(1000, 400, ['router:text:0.40']) }),
      measurement({ payloadId: 'b', stats: stats(2000, 500, ['router:text:0.25']) }),
      measurement({ payloadId: 'c', stats: stats(3000, 3000, ['router:noop']) }),
    ]);

    const text = rows.find((r) => r.engine === 'router:text')!;
    expect(text.payloadsTotal).toBe(2);
    expect(text.payloadsMeasured).toBe(2);
    expect(text.tokens.available).toBe(true);
    if (text.tokens.available) {
      expect(text.tokens.value.before).toBe(3000);
      expect(text.tokens.value.after).toBe(900);
      expect(text.tokens.value.saved).toBe(2100);
      expect(text.tokens.value.ratio).toBeCloseTo(0.3, 10);
    }

    expect(rows.find((r) => r.engine === 'router:noop')!.payloadsTotal).toBe(1);
  });

  it('counts a payload whose stats are absent without inventing a zero', () => {
    const rows = aggregateByEngine([
      measurement({ payloadId: 'a', stats: stats(1000, 400, ['router:text:0.40']) }),
      measurement({
        payloadId: 'b',
        stats: headroomUnavailable('service-unavailable'),
        accepted: false,
        fidelity: { kind: 'not-compressed' },
      }),
    ]);

    // The unmeasured payload lands in an explicitly-unattributed bucket. It must
    // NOT quietly join `router:text` and it must NOT add 0 tokens to anything.
    const text = rows.find((r) => r.engine === 'router:text')!;
    expect(text.payloadsTotal).toBe(1);
    expect(text.tokens.available && text.tokens.value.before).toBe(1000);

    const unattributed = rows.find((r) => r.engine === 'unattributed')!;
    expect(unattributed.payloadsTotal).toBe(1);
    expect(unattributed.payloadsMeasured).toBe(0);
    expect(unattributed.tokens.available).toBe(false);
    if (!unattributed.tokens.available) {
      expect(unattributed.tokens.reason).toBe('service-unavailable');
    }
  });

  it('reports a group with no measured stats as absent, not as zero savings', () => {
    const rows = aggregateByEngine([
      measurement({
        stats: headroomUnavailable('sdk-unavailable'),
        accepted: false,
        fidelity: { kind: 'not-compressed' },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.available).toBe(false);
  });

  it('attributes a payload to every engine its transforms name', () => {
    // The proxy reports a list; a payload that went through a protection pass
    // and a compressor belongs to both rows, and each row says so.
    const rows = aggregateByEngine([
      measurement({
        stats: stats(1000, 500, ['router:protected:system_message', 'router:mixed:0.50']),
      }),
    ]);

    expect(rows.map((r) => r.engine).sort()).toEqual([
      'router:mixed',
      'router:protected:system_message',
    ]);
    for (const row of rows) {
      expect(row.payloadsMeasured).toBe(1);
    }
  });

  it('returns no rows for no measurements', () => {
    expect(aggregateByEngine([])).toEqual([]);
  });
});

describe('aggregateLatency', () => {
  it('reports p50/p95 over the samples it was given', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms) =>
      measurement({ latencyMs: ms, baselineLatencyMs: 0 }),
    );
    const l = aggregateLatency(rows);

    expect(l.available).toBe(true);
    if (l.available) {
      expect(l.value.samples).toBe(10);
      // Nearest rank, never interpolated: p50 of ten samples is the fifth.
      expect(l.value.p50Ms).toBe(5);
      expect(l.value.p95Ms).toBe(10);
      expect(l.value.baselineP50Ms).toBe(0);
      // Overhead is stated against the no-op path, which is Vorno's real "off".
      expect(l.value.overheadP50Ms).toBe(5);
    }
  });

  it('is absent rather than zero when there are no samples', () => {
    const l = aggregateLatency([]);
    expect(l.available).toBe(false);
  });
});

describe('deviations', () => {
  it('lists every payload whose original is not byte-recoverable', () => {
    const rows = [
      measurement({ payloadId: 'ok', fidelity: { kind: 'round-trip-identical', handle: 'h' } }),
      measurement({ payloadId: 'untouched', accepted: false, fidelity: { kind: 'not-compressed' } }),
      measurement({
        payloadId: 'lossy',
        fidelity: { kind: 'no-handle', bytesDropped: 4096 },
      }),
      measurement({
        payloadId: 'differs',
        fidelity: { kind: 'round-trip-differs', handle: 'h2', retrievedBytes: 12 },
      }),
      measurement({
        payloadId: 'unreachable',
        fidelity: { kind: 'retrieve-failed', handle: 'h3', reason: 'unknown-handle' },
      }),
    ];

    expect(deviations(rows).map((d) => d.payloadId)).toEqual([
      'lossy',
      'differs',
      'unreachable',
    ]);
  });

  it('treats an uncompressed payload as no deviation', () => {
    // Pass-through leaves the caller's own string in context. There is nothing
    // to retrieve and nothing was lost.
    expect(
      deviations([measurement({ accepted: false, fidelity: { kind: 'not-compressed' } })]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderReportMarkdown', () => {
  const report = {
    generatedAt: '2026-08-27T00:00:00.000Z',
    adapterKind: 'sdk' as const,
    baseUrl: 'http://127.0.0.1:8788',
    sdkVersion: '0.36.5',
    proxyVersion: '0.36.5',
    profile: 'coding',
    workloads: [
      {
        id: 'sess-1',
        kind: 'session-transcript' as const,
        source: '/tmp/session.jsonl',
        sha256: 'abc123',
        payloads: 2,
        bytes: 8192,
      },
    ],
    measurements: [
      measurement({ payloadId: 'a' }),
      measurement({
        payloadId: 'b',
        stats: headroomUnavailable('service-unavailable'),
        accepted: false,
        fidelity: { kind: 'not-compressed' },
      }),
    ],
  };

  it('prints "not measured" instead of a number for an absent group', () => {
    const md = renderReportMarkdown(report);

    // The unattributed row exists, states 0 of 1 measured, and carries no
    // numbers at all — the zeros a naive sum would have produced are absent.
    const row = md
      .split('\n')
      .find((line) => line.startsWith('| `unattributed`'));
    expect(row).toBeDefined();
    expect(row).toContain('0 / 1');
    // All four token cells — before, after, saved, ratio — are absent. The
    // counts that precede them (`0 / 1`, `0` accepted) are real counts, not
    // measurements, and are expected to be numeric.
    expect(row!.match(/not measured/g)).toHaveLength(4);
  });

  it('states the denominator for every engine row', () => {
    const md = renderReportMarkdown(report);
    expect(md).toContain('router:text');
    expect(md).toMatch(/1\s*\/\s*1/);
  });

  it('records the exact adapter, proxy and profile the numbers came from', () => {
    const md = renderReportMarkdown(report);
    expect(md).toContain('0.36.5');
    expect(md).toContain('coding');
    expect(md).toContain('http://127.0.0.1:8788');
  });
});
