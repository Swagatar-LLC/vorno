/**
 * Benchmark harness logic (fork: PLAN-040 / SUV-0025).
 *
 * PLAN-040's I0 acceptance needs numbers, and the plan states the rule those
 * numbers live under: **measured or absent, never interpolated.** This module is
 * where that rule is enforced, so it is deliberately *pure* — parse a workload,
 * attribute a measurement to an engine, classify what happened to the original
 * bytes, aggregate, render. The impure half (a live proxy, the real adapter,
 * wall-clock timing, the filesystem) lives in `scripts/benchmark-headroom.ts`.
 *
 * Nothing in Vorno's product path imports this. It exists here rather than under
 * `scripts/` for one reason: `bun run test:shared` is a CI gate and a test under
 * `scripts/` is not, and the arithmetic that decides a rollout default is not
 * something to leave ungated.
 *
 * Three design notes, each of which a reader will otherwise expect differently:
 *
 * - **A payload can belong to several engine rows.** The proxy answers with a
 *   *list* of transforms (`['router:protected:system_message', 'router:mixed:0.64']`),
 *   not one engine id. Attributing the payload to only the first would silently
 *   drop the fact that a protection pass ran; splitting its tokens between rows
 *   would invent a denominator nobody measured. So each row counts the whole
 *   payload and each row states its own denominator, and the rows deliberately
 *   do not sum to the total.
 * - **`unattributed` is a real row, not an error.** A payload whose stats came
 *   back absent has no engine to attribute to. It still happened, and it still
 *   has to be counted somewhere, or the report's denominators quietly shrink to
 *   the subset that worked.
 * - **Fidelity is about the *original*, not about the compressed text.** The
 *   question a rollout default hangs on is "can this content still be recovered
 *   after compression?" — so pass-through is not a deviation (the caller keeps
 *   its own string), and compressed-with-no-handle is (the bytes are gone).
 */

import type {
  HeadroomCompressStats,
  HeadroomMeasurement,
  HeadroomMessage,
  HeadroomUnavailableReason,
} from '@craft-agent/core/types';
import { headroomMeasured, headroomUnavailable } from '@craft-agent/core/types';

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

/** Which shipped call site's shape a payload is replayed through. */
export type BenchmarkCallSite = 'session-loop' | 'conductor-dispatch';

export type BenchmarkPayloadKind = 'session-tool-output' | 'workflow-node-output';

/** One unit of real content the harness pushes through the adapter. */
export interface BenchmarkPayload {
  /** Stable id within the workload — the tool-use id, or the node id. */
  readonly id: string;
  readonly kind: BenchmarkPayloadKind;
  readonly content: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

export type BenchmarkWorkloadKind = 'session-transcript' | 'workflow-run';

export interface BenchmarkWorkload {
  readonly id: string;
  readonly kind: BenchmarkWorkloadKind;
  /** Absolute path the content was read from. Recorded, never published. */
  readonly source: string;
  readonly payloads: readonly BenchmarkPayload[];
  /**
   * The conversation preceding the payloads, in order.
   *
   * Load-bearing, not decoration: the proxy's ContentRouter protects content it
   * considers *recent*, so the same tool result compresses differently as the
   * only message in a conversation than it does twenty turns deep. A harness
   * that replayed payloads in isolation would measure a workload Vorno never
   * runs. Empty for workflow runs, which genuinely compress a lone message.
   */
  readonly history: readonly HeadroomMessage[];
}

export interface WorkloadParseOptions {
  /**
   * Skip payloads smaller than this. Compression has nothing to win on a short
   * string, and including them would pad every denominator with trivial passes.
   */
  readonly minPayloadBytes: number;
}

/** Session-transcript record types that carry model context. */
const CONTEXT_RECORD_TYPES = new Set(['user', 'assistant', 'tool']);

/**
 * The text a transcript record actually put in front of the model.
 *
 * `toolResult` before `content`, and the distinction is not cosmetic: on a tool
 * record, `content` is the short line the UI renders (`"Read 412 lines"`) while
 * `toolResult` is the payload that entered context. Reading `content` measures
 * the display string — a benchmark that did so would report a workspace of
 * 40-byte payloads and conclude, wrongly, that there is nothing to compress.
 * Older transcripts wrote the full result to both fields, which is why the
 * mistake is invisible until a newer session is sampled.
 *
 * Returns `null` when the record carries no usable text.
 */
function toolRecordContent(record: Record<string, unknown>): string | null {
  const toolResult = record.toolResult;
  if (typeof toolResult === 'string' && toolResult.length > 0) return toolResult;
  const content = record.content;
  if (typeof content === 'string' && content.length > 0) return content;
  return null;
}

/**
 * Parse a Vorno `session.jsonl` into a workload.
 *
 * Tolerant by construction: the first line is a session header rather than a
 * message, transcripts contain `plan` / `info` / `error` records that never
 * reach a model, and a truncated write can leave an unparseable final line. All
 * three are skipped. Never throws.
 */
export function parseSessionTranscript(
  id: string,
  source: string,
  lines: readonly string[],
  options: WorkloadParseOptions,
): BenchmarkWorkload {
  const history: HeadroomMessage[] = [];
  const payloads: BenchmarkPayload[] = [];

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = record.type;
    if (typeof type !== 'string' || !CONTEXT_RECORD_TYPES.has(type)) continue;

    const content = toolRecordContent(record);
    if (content === null) continue;

    if (type === 'tool') {
      const toolCallId = typeof record.toolUseId === 'string' ? record.toolUseId : '';
      if (toolCallId.length === 0) continue;
      const toolName = typeof record.toolName === 'string' ? record.toolName : undefined;

      history.push({
        role: 'tool',
        content,
        toolCallId,
        ...(toolName === undefined ? {} : { name: toolName }),
      });

      if (content.length >= options.minPayloadBytes) {
        payloads.push({
          id: toolCallId,
          kind: 'session-tool-output',
          content,
          toolCallId,
          ...(toolName === undefined ? {} : { toolName }),
        });
      }
      continue;
    }

    history.push({ role: type as 'user' | 'assistant', content });
  }

  return { id, kind: 'session-transcript', source, payloads, history };
}

/**
 * Parse a Conductor run's node outputs into a workload.
 *
 * No history: `TaskRunner.compressOutput` compresses a node's output as a lone
 * `assistant` message, and the harness replays exactly that shape rather than a
 * more flattering one.
 */
export function parseWorkflowRun(
  id: string,
  source: string,
  nodes: readonly { readonly id: string; readonly text: string }[],
  options: WorkloadParseOptions,
): BenchmarkWorkload {
  const payloads = nodes
    .filter((node) => node.text.length >= options.minPayloadBytes)
    .map((node) => ({
      id: node.id,
      kind: 'workflow-node-output' as const,
      content: node.text,
    }));

  return { id, kind: 'workflow-run', source, payloads, history: [] };
}

// ---------------------------------------------------------------------------
// Fidelity
// ---------------------------------------------------------------------------

/**
 * What became of the original bytes.
 *
 * Five arms, because "did compression lose anything?" has five genuinely
 * different answers and collapsing any two of them would hide the one that
 * decides the rollout default.
 */
export type FidelityOutcome =
  /** Pass-through. The caller's own string stayed in context; nothing to redeem. */
  | { readonly kind: 'not-compressed' }
  /** Compressed, and `retrieve(handle)` returned the original byte for byte. */
  | { readonly kind: 'round-trip-identical'; readonly handle: string }
  /** Compressed, handle redeemed, and what came back was not the original. */
  | {
      readonly kind: 'round-trip-differs';
      readonly handle: string;
      readonly retrievedBytes: number;
    }
  /** Compressed, but the handle could not be redeemed at all. */
  | { readonly kind: 'retrieve-failed'; readonly handle: string; readonly reason: string }
  /**
   * Compressed with no handle issued. The original is not recoverable through
   * the adapter — the single most consequential outcome the harness can find.
   */
  | { readonly kind: 'no-handle'; readonly bytesDropped: number };

export interface PayloadMeasurement {
  readonly payloadId: string;
  readonly workloadId: string;
  readonly kind: BenchmarkPayloadKind;
  readonly callSite: BenchmarkCallSite;
  readonly bytesBefore: number;
  /**
   * Whether the *shipped call site* took the compressed result.
   *
   * Distinct from `stats.available`: the proxy can compress successfully and
   * report real numbers while `compressToolOutput`'s acceptance rules still
   * reject the response, in which case Vorno's context is unchanged and the
   * savings are not real savings.
   */
  readonly accepted: boolean;
  readonly stats: HeadroomMeasurement<HeadroomCompressStats>;
  readonly latencyMs: number;
  /** Same payload through the no-op adapter — Vorno's actual "off" state. */
  readonly baselineLatencyMs: number;
  readonly fidelity: FidelityOutcome;
}

/**
 * Every payload whose original is not recoverable byte for byte.
 *
 * This is the list acceptance item 4 requires the report to reproduce in full.
 */
export function deviations(
  measurements: readonly PayloadMeasurement[],
): readonly PayloadMeasurement[] {
  return measurements.filter(
    (m) => m.fidelity.kind !== 'not-compressed' && m.fidelity.kind !== 'round-trip-identical',
  );
}

// ---------------------------------------------------------------------------
// Engine attribution
// ---------------------------------------------------------------------------

/**
 * Reduce a proxy transform label to the engine it names.
 *
 * The proxy appends the achieved ratio to a compressor label
 * (`router:mixed:0.64`) but appends a *reason* to a protection label
 * (`router:protected:system_message`). Only a trailing segment that parses as a
 * number is a ratio, so only that is stripped — merging the protection reasons
 * would collapse distinct outcomes into one meaningless row.
 */
export function normalizeEngineLabel(label: string): string {
  const parts = label.split(':');
  if (parts.length < 2) return label;
  const last = parts[parts.length - 1]!;
  if (last.length > 0 && Number.isFinite(Number(last))) {
    return parts.slice(0, -1).join(':');
  }
  return label;
}

/** The row every payload with no measured stats lands in. */
export const UNATTRIBUTED_ENGINE = 'unattributed';

export interface EngineTokens {
  readonly before: number;
  readonly after: number;
  readonly saved: number;
  /** `after / before`, from measured payloads only. Lower is more compression. */
  readonly ratio: number;
}

export interface EngineAggregate {
  readonly engine: string;
  /** Payloads attributed to this engine, measured or not. The denominator. */
  readonly payloadsTotal: number;
  /** Of those, how many carried usable numbers. */
  readonly payloadsMeasured: number;
  /** Absent — never zeroed — when `payloadsMeasured` is 0. */
  readonly tokens: HeadroomMeasurement<EngineTokens>;
  /** How many of the attributed payloads the shipped call site accepted. */
  readonly payloadsAccepted: number;
}

/**
 * Group measurements by engine.
 *
 * A payload is counted once in every row its transform list names, and once in
 * `unattributed` if it named none. Rows therefore do not sum to the payload
 * count, which is why each carries its own denominator.
 */
export function aggregateByEngine(
  measurements: readonly PayloadMeasurement[],
): readonly EngineAggregate[] {
  interface Bucket {
    total: number;
    measured: number;
    accepted: number;
    before: number;
    after: number;
    saved: number;
    /** Why this bucket has no numbers, when it has none. */
    reason?: HeadroomUnavailableReason;
  }

  const buckets = new Map<string, Bucket>();
  const bucketFor = (engine: string): Bucket => {
    let bucket = buckets.get(engine);
    if (!bucket) {
      bucket = { total: 0, measured: 0, accepted: 0, before: 0, after: 0, saved: 0 };
      buckets.set(engine, bucket);
    }
    return bucket;
  };

  for (const m of measurements) {
    if (!m.stats.available) {
      const bucket = bucketFor(UNATTRIBUTED_ENGINE);
      bucket.total += 1;
      if (m.accepted) bucket.accepted += 1;
      // First reason wins; a mixed bucket is reported by its first cause rather
      // than by a synthesized "various", which would name no real failure.
      bucket.reason ??= m.stats.reason;
      continue;
    }

    const engines = new Set(m.stats.value.transformsApplied.map(normalizeEngineLabel));
    if (engines.size === 0) engines.add(UNATTRIBUTED_ENGINE);

    for (const engine of engines) {
      const bucket = bucketFor(engine);
      bucket.total += 1;
      bucket.measured += 1;
      if (m.accepted) bucket.accepted += 1;
      bucket.before += m.stats.value.tokensBefore;
      bucket.after += m.stats.value.tokensAfter;
      bucket.saved += m.stats.value.tokensSaved;
    }
  }

  return [...buckets.entries()]
    .map(([engine, bucket]): EngineAggregate => ({
      engine,
      payloadsTotal: bucket.total,
      payloadsMeasured: bucket.measured,
      payloadsAccepted: bucket.accepted,
      tokens:
        bucket.measured === 0
          ? headroomUnavailable<EngineTokens>(bucket.reason ?? 'service-unavailable')
          : headroomMeasured<EngineTokens>({
              before: bucket.before,
              after: bucket.after,
              saved: bucket.saved,
              ratio: bucket.before === 0 ? 1 : bucket.after / bucket.before,
            }),
    }))
    .sort((a, b) => b.payloadsTotal - a.payloadsTotal || a.engine.localeCompare(b.engine));
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

export interface LatencySummary {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** The no-op adapter over the same payloads — the stated baseline. */
  readonly baselineP50Ms: number;
  readonly baselineP95Ms: number;
  /** `p50Ms - baselineP50Ms`. What enabling Headroom actually costs per call. */
  readonly overheadP50Ms: number;
  readonly overheadP95Ms: number;
}

/** Nearest-rank percentile. No interpolation — the rule applies here too. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function aggregateLatency(
  measurements: readonly PayloadMeasurement[],
): HeadroomMeasurement<LatencySummary> {
  if (measurements.length === 0) return headroomUnavailable('service-unavailable');

  const live = [...measurements.map((m) => m.latencyMs)].sort((a, b) => a - b);
  const base = [...measurements.map((m) => m.baselineLatencyMs)].sort((a, b) => a - b);

  const p50 = percentile(live, 50);
  const p95 = percentile(live, 95);
  const basep50 = percentile(base, 50);
  const basep95 = percentile(base, 95);

  return headroomMeasured({
    samples: measurements.length,
    p50Ms: p50,
    p95Ms: p95,
    maxMs: live[live.length - 1]!,
    baselineP50Ms: basep50,
    baselineP95Ms: basep95,
    overheadP50Ms: p50 - basep50,
    overheadP95Ms: p95 - basep95,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface WorkloadSummary {
  readonly id: string;
  readonly kind: BenchmarkWorkloadKind;
  /** Absolute local path. Recorded so a run is auditable, not for publication. */
  readonly source: string;
  /** Content hash of the replayed payloads, so a published number is checkable. */
  readonly sha256: string;
  readonly payloads: number;
  readonly bytes: number;
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  /** `'sdk'` or `'noop'`. A noop run has no numbers worth publishing. */
  readonly adapterKind: string;
  readonly baseUrl: string;
  readonly sdkVersion: string;
  readonly proxyVersion: string;
  /** The proxy's `HEADROOM_SAVINGS_PROFILE` this pass ran under. */
  readonly profile: string;
  /**
   * The discarded first call, in ms.
   *
   * Reported rather than hidden: the proxy loads its compressors lazily, so the
   * first compression of a process pays a cost no later one does. Folding it
   * into p95 would overstate steady state; dropping it silently would hide what
   * a session's first turn actually costs.
   */
  readonly warmupMs?: number;
  readonly workloads: readonly WorkloadSummary[];
  readonly measurements: readonly PayloadMeasurement[];
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** The literal a cell carries when there is nothing measured to put in it. */
const ABSENT = 'not measured';

function renderEngineTable(rows: readonly EngineAggregate[]): string {
  const header = [
    '| Engine | Payloads measured | Accepted by call site | Tokens before | Tokens after | Tokens saved | Keep ratio |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  const body = rows.map((row) => {
    const denominator = `${row.payloadsMeasured} / ${row.payloadsTotal}`;
    if (!row.tokens.available) {
      return `| \`${row.engine}\` | ${denominator} | ${row.payloadsAccepted} | ${ABSENT} | ${ABSENT} | ${ABSENT} | ${ABSENT} |`;
    }
    const t = row.tokens.value;
    return `| \`${row.engine}\` | ${denominator} | ${row.payloadsAccepted} | ${t.before.toLocaleString('en-US')} | ${t.after.toLocaleString('en-US')} | ${t.saved.toLocaleString('en-US')} | ${pct(t.ratio)} |`;
  });

  return [...header, ...body].join('\n');
}

function renderLatency(latency: HeadroomMeasurement<LatencySummary>): string {
  if (!latency.available) {
    return `Latency: ${ABSENT} (${latency.reason}).`;
  }
  const l = latency.value;
  return [
    '| Metric | Headroom enabled | No-op baseline | Overhead |',
    '| --- | --- | --- | --- |',
    `| p50 | ${l.p50Ms.toFixed(1)} ms | ${l.baselineP50Ms.toFixed(1)} ms | ${l.overheadP50Ms.toFixed(1)} ms |`,
    `| p95 | ${l.p95Ms.toFixed(1)} ms | ${l.baselineP95Ms.toFixed(1)} ms | ${l.overheadP95Ms.toFixed(1)} ms |`,
    `| max | ${l.maxMs.toFixed(1)} ms | — | — |`,
    '',
    `Samples: ${l.samples}. Baseline is the no-op adapter over the identical payloads — Vorno's real "off" state, not "no boundary at all".`,
  ].join('\n');
}

function describeFidelity(outcome: FidelityOutcome): string {
  switch (outcome.kind) {
    case 'not-compressed':
      return 'pass-through (original untouched)';
    case 'round-trip-identical':
      return `round-trip byte-identical via \`${outcome.handle}\``;
    case 'round-trip-differs':
      return `**retrieved content differs** (${outcome.retrievedBytes.toLocaleString('en-US')} bytes back) via \`${outcome.handle}\``;
    case 'retrieve-failed':
      return `**handle could not be redeemed** (\`${outcome.handle}\`, ${outcome.reason})`;
    case 'no-handle':
      return `**compressed with no retrieval handle** — ${outcome.bytesDropped.toLocaleString('en-US')} bytes not recoverable through the adapter`;
  }
}

function renderDeviations(rows: readonly PayloadMeasurement[]): string {
  if (rows.length === 0) {
    return 'No deviations: every compressed payload round-tripped byte-identically, and every other payload passed through untouched.';
  }
  return [
    '| Workload | Payload | Call site | Bytes | Deviation |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.workloadId}\` | \`${r.payloadId}\` | ${r.callSite} | ${r.bytesBefore.toLocaleString('en-US')} | ${describeFidelity(r.fidelity)} |`,
    ),
  ].join('\n');
}

/**
 * Render one pass as markdown.
 *
 * Every cell either carries a number the harness measured or says
 * `not measured`. There is no code path here that produces a `0` from an absent
 * measurement, which is what the rendering tests assert.
 */
export function renderReportMarkdown(report: BenchmarkReport): string {
  const bySite = (site: BenchmarkCallSite) =>
    report.measurements.filter((m) => m.callSite === site);

  const sections = [
    `### Profile \`${report.profile}\``,
    '',
    `- Adapter: \`${report.adapterKind}\` · SDK \`headroom-ai@${report.sdkVersion}\` · proxy \`${report.proxyVersion}\` · \`${report.baseUrl}\``,
    `- Generated: ${report.generatedAt}`,
    '',
    '#### Workloads',
    '',
    '| Workload | Kind | Payloads | Bytes | sha256 (payloads) |',
    '| --- | --- | --- | --- | --- |',
    ...report.workloads.map(
      (w) =>
        `| \`${w.id}\` | ${w.kind} | ${w.payloads} | ${w.bytes.toLocaleString('en-US')} | \`${w.sha256.slice(0, 16)}\` |`,
    ),
    '',
    '#### Token savings per engine',
    '',
    renderEngineTable(aggregateByEngine(report.measurements)),
    '',
    '#### Latency',
    '',
    renderLatency(aggregateLatency(report.measurements)),
    '',
    report.warmupMs === undefined
      ? `First-call warm-up: ${ABSENT}.`
      : `First-call warm-up (discarded from the table above): ${report.warmupMs.toFixed(0)} ms — a per-proxy-process cost, paid once, not per call.`,
    '',
    '#### Acceptance by call site',
    '',
    '| Call site | Payloads | Accepted | Passed through |',
    '| --- | --- | --- | --- |',
    ...(['session-loop', 'conductor-dispatch'] as const).map((site) => {
      const rows = bySite(site);
      const accepted = rows.filter((r) => r.accepted).length;
      return `| ${site} | ${rows.length} | ${accepted} | ${rows.length - accepted} |`;
    }),
    '',
    '#### Retrieval fidelity',
    '',
    renderDeviations(deviations(report.measurements)),
  ];

  return sections.join('\n');
}
