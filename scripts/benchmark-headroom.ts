/**
 * Headroom benchmark harness (fork: PLAN-040 / SUV-0025).
 *
 * Replays real Vorno workloads — session transcripts and Conductor workflow
 * runs, read off this machine — through the **real** boundary adapter against a
 * **real** Headroom proxy, and reports token savings, latency overhead and
 * retrieval fidelity per compression engine.
 *
 * Usage:
 *
 *     headroom proxy --port 8788                      # in another terminal, or use --spawn-proxy
 *     bun run scripts/benchmark-headroom.ts --base-url http://127.0.0.1:8788
 *     bun run scripts/benchmark-headroom.ts --spawn-proxy --profiles coding,agent-90,balanced,general
 *
 * All pure logic lives in `packages/shared/src/headroom/benchmark.ts` and is
 * unit-tested under `bun run test:shared`. This file is the impure half: the
 * filesystem, the proxy's lifecycle, the clock, and the adapter calls.
 *
 * ## Four rules this harness holds itself to
 *
 * 1. **Real adapter or no numbers.** If `createHeadroomAdapter` hands back the
 *    no-op — SDK absent, Headroom disabled, proxy unreachable — the harness
 *    exits non-zero and publishes nothing. A benchmark that silently measures
 *    the fallback path is worse than no benchmark.
 * 2. **Real workloads, never committed.** Session transcripts are real user
 *    content and do not belong in git. The harness reads them from the local
 *    workspace and publishes only measurements plus a sha256 of the replayed
 *    payloads, so a published number stays checkable without the content
 *    leaving the machine.
 * 3. **The shipped call sites decide acceptance, not this file.** Session-loop
 *    payloads go through the real `compressToolOutput` (SUV-0023) with all four
 *    of its acceptance rules intact. Conductor payloads replay
 *    `TaskRunner.compressOutput`'s exact request shape (SUV-0024): one
 *    `assistant` message, compressed text joined back. Measuring a friendlier
 *    call shape than the product uses would produce numbers about nothing.
 * 4. **Baseline is the no-op adapter.** Latency overhead is stated against
 *    Vorno's real "off" state — the boundary in no-op mode — not against having
 *    no boundary at all.
 *
 * ## Why the proxy is spawned per profile
 *
 * `HEADROOM_SAVINGS_PROFILE` is startup-only: `POST /settings/apply` answers
 * `{"restarted": false, "instruction": "Restart the proxy to apply the new
 * settings."}`. So a multi-profile pass needs one proxy process per profile,
 * each on its own port with its own `HEADROOM_CONFIG_DIR`, and the harness
 * records the profile the proxy *reports*, never the one that was requested.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  HeadroomAdapter,
  HeadroomCompressStats,
  HeadroomMeasurement,
  HeadroomMessage,
} from '@craft-agent/core/types';
import {
  createHeadroomAdapter,
  createNoopHeadroomAdapter,
} from '../packages/shared/src/headroom/index.ts';
import { compressToolOutput } from '../packages/shared/src/headroom/tool-output.ts';
import {
  parseSessionTranscript,
  parseWorkflowRun,
  renderReportMarkdown,
  type BenchmarkPayload,
  type BenchmarkReport,
  type BenchmarkWorkload,
  type FidelityOutcome,
  type PayloadMeasurement,
  type WorkloadSummary,
} from '../packages/shared/src/headroom/benchmark.ts';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  baseUrl: string;
  spawnProxy: boolean;
  profiles: string[];
  sessions: string[];
  runs: string[];
  workspace: string;
  maxSessions: number;
  maxPayloadsPerWorkload: number;
  minPayloadBytes: number;
  model: string;
  outJson?: string;
  outMarkdown?: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    baseUrl: 'http://127.0.0.1:8787',
    spawnProxy: false,
    profiles: [],
    sessions: [],
    runs: [],
    workspace: join(homedir(), '.craft-agent', 'workspaces', 'my-workspace'),
    maxSessions: 3,
    maxPayloadsPerWorkload: 12,
    minPayloadBytes: 2048,
    model: 'claude-opus-5',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--base-url': options.baseUrl = next(); break;
      case '--spawn-proxy': options.spawnProxy = true; break;
      case '--profiles': options.profiles = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--session': options.sessions.push(next()); break;
      case '--run': options.runs.push(next()); break;
      case '--workspace': options.workspace = next(); break;
      case '--max-sessions': options.maxSessions = Number(next()); break;
      case '--max-payloads': options.maxPayloadsPerWorkload = Number(next()); break;
      case '--min-bytes': options.minPayloadBytes = Number(next()); break;
      case '--model': options.model = next(); break;
      case '--out-json': options.outJson = next(); break;
      case '--out-md': options.outMarkdown = next(); break;
      case '--help':
        console.log(HELP);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.profiles.length === 0) options.profiles = ['coding'];
  return options;
}

const HELP = `benchmark-headroom — replay real Vorno workloads through the real Headroom adapter

  --base-url <url>       Proxy to measure against (default http://127.0.0.1:8787).
  --spawn-proxy          Start a proxy per profile (needs the \`headroom\` CLI on PATH).
  --profiles a,b,c       HEADROOM_SAVINGS_PROFILE values to measure (default: coding).
  --session <path>       session.jsonl to replay. Repeatable. Default: auto-discover.
  --run <path>           Conductor run directory to replay. Repeatable. Default: auto-discover.
  --workspace <path>     Workspace to auto-discover workloads in.
  --max-sessions <n>     How many transcripts to auto-discover (default 3).
  --max-payloads <n>     Payloads sampled per workload (default 12).
  --min-bytes <n>        Skip payloads smaller than this (default 2048).
  --model <id>           Model id sent with each compress call.
  --out-json <path>      Write raw measurements as JSON.
  --out-md <path>        Write the rendered markdown report.
`;

// ---------------------------------------------------------------------------
// Workload discovery
// ---------------------------------------------------------------------------

function sha256(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value);
  return hash.digest('hex');
}

/** The largest transcripts in the workspace — the ones with context worth compressing. */
function discoverSessions(workspace: string, limit: number): string[] {
  const root = join(workspace, 'sessions');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  return entries
    .map((name) => join(root, name, 'session.jsonl'))
    .map((path) => {
      try {
        return { path, size: statSync(path).size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; size: number } => entry !== null)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** Every Conductor run directory in the workspace, newest first. */
function discoverRuns(workspace: string, limit: number): string[] {
  const tasksRoot = join(workspace, 'tasks');
  let slugs: string[];
  try {
    slugs = readdirSync(tasksRoot);
  } catch {
    return [];
  }

  const found: { path: string; mtimeMs: number }[] = [];
  for (const slug of slugs) {
    const runsRoot = join(tasksRoot, slug, 'runs');
    let runIds: string[];
    try {
      runIds = readdirSync(runsRoot);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const path = join(runsRoot, runId);
      try {
        found.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        /* unreadable run directory — skip */
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((r) => r.path);
}

function loadSessionWorkload(path: string, minPayloadBytes: number): BenchmarkWorkload {
  const id = path.split('/').slice(-2, -1)[0] ?? path;
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  return parseSessionTranscript(id, path, lines, { minPayloadBytes });
}

function loadRunWorkload(path: string, minPayloadBytes: number): BenchmarkWorkload {
  const nodesRoot = join(path, 'nodes');
  let files: string[];
  try {
    files = readdirSync(nodesRoot).filter((f) => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }

  const nodes = files.flatMap((file) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(nodesRoot, file), 'utf8'));
      const text = (parsed as { text?: unknown } | null)?.text;
      if (typeof text !== 'string') return [];
      return [{ id: file.replace(/\.json$/, ''), text }];
    } catch {
      return [];
    }
  });

  const id = path.split('/').slice(-3).join('/');
  return parseWorkflowRun(id, path, nodes, { minPayloadBytes });
}

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

interface ProxyHandle {
  baseUrl: string;
  version: string;
  /** The profile the proxy reports, which may differ from what was requested. */
  profile: string;
  stop: () => void;
}

async function proxyHealth(baseUrl: string): Promise<{ version: string } | null> {
  try {
    const response = await fetch(`${baseUrl}/livez`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return { version: typeof body.version === 'string' ? body.version : 'unknown' };
  } catch {
    return null;
  }
}

/**
 * Read the profile the proxy is actually running under.
 *
 * Reported rather than assumed: a proxy started with an unrecognised profile
 * name still starts, and publishing the requested value would attribute numbers
 * to a configuration that never ran.
 */
async function proxyProfile(baseUrl: string, fallback: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/settings/schema`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as {
      fields?: { key?: unknown; value?: unknown }[];
    };
    const field = body.fields?.find((f) => f.key === 'savings_profile');
    return typeof field?.value === 'string' ? field.value : fallback;
  } catch {
    return fallback;
  }
}

async function waitForProxy(baseUrl: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await proxyHealth(baseUrl);
    if (health) return health.version;
    if (Date.now() > deadline) throw new Error(`proxy at ${baseUrl} did not become healthy`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function startProxy(profile: string, port: number): Promise<ProxyHandle> {
  const configDir = mkdtempSync(join(tmpdir(), 'headroom-bench-'));
  const baseUrl = `http://127.0.0.1:${port}`;

  let child: ChildProcess;
  try {
    child = spawn('headroom', ['proxy', '--port', String(port), '--host', '127.0.0.1'], {
      env: {
        ...process.env,
        HEADROOM_CONFIG_DIR: configDir,
        HEADROOM_WORKSPACE_DIR: join(configDir, 'ws'),
        HEADROOM_SAVINGS_PROFILE: profile,
      },
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error(
      `could not spawn the \`headroom\` CLI (${String(error)}). ` +
        'Install it with: uv tool install --python 3.13 "headroom-ai[proxy]==0.36.5"',
    );
  }

  const version = await waitForProxy(baseUrl, 90_000);
  return {
    baseUrl,
    version,
    profile: await proxyProfile(baseUrl, profile),
    stop: () => child.kill('SIGTERM'),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Time one awaited call. Wall clock, in fractional milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

/**
 * Replay one payload through the session-loop call site (SUV-0023).
 *
 * Uses the shipped `compressToolOutput`, so its four acceptance rules — most
 * importantly "exactly one retrieval handle" — decide `accepted` exactly as they
 * do in a live session.
 */
async function measureSessionLoop(
  adapter: HeadroomAdapter,
  noop: HeadroomAdapter,
  workload: BenchmarkWorkload,
  payload: BenchmarkPayload,
): Promise<PayloadMeasurement> {
  const input = {
    toolCallId: payload.toolCallId ?? payload.id,
    ...(payload.toolName === undefined ? {} : { toolName: payload.toolName }),
    content: payload.content,
  };

  const live = await timed(() => compressToolOutput(adapter, input));
  const baseline = await timed(() => compressToolOutput(noop, input));

  const accepted = live.value.handle !== undefined;
  const fidelity: FidelityOutcome = accepted
    ? await checkRoundTrip(adapter, live.value.handle!, payload.content)
    : { kind: 'not-compressed' };

  return {
    payloadId: payload.id,
    workloadId: workload.id,
    kind: payload.kind,
    callSite: 'session-loop',
    bytesBefore: payload.content.length,
    accepted,
    stats: live.value.stats,
    latencyMs: live.ms,
    baselineLatencyMs: baseline.ms,
    fidelity,
  };
}

/**
 * Replay one payload through the Conductor dispatch call site (SUV-0024).
 *
 * Mirrors `TaskRunner.compressOutput`: one `assistant` message in, compressed
 * message contents joined with newlines out, and — the part that matters — the
 * result is taken whenever `compressed` is true, with no handle required. That
 * asymmetry with the session loop is the whole reason both are measured.
 */
async function measureConductor(
  adapter: HeadroomAdapter,
  noop: HeadroomAdapter,
  workload: BenchmarkWorkload,
  payload: BenchmarkPayload,
  model: string,
): Promise<PayloadMeasurement> {
  const request = {
    messages: [{ role: 'assistant', content: payload.content }] as readonly HeadroomMessage[],
    model,
  };

  const live = await timed(() => adapter.compress(request));
  const baseline = await timed(() => noop.compress(request));

  const accepted = live.value.compressed;
  let fidelity: FidelityOutcome = { kind: 'not-compressed' };

  if (accepted) {
    const handle = live.value.retrievalHandles[0];
    if (handle === undefined) {
      const compressedText = live.value.messages.map((m) => m.content).join('\n');
      // Conductor puts this text into downstream context. With no handle, the
      // difference between it and the original is unrecoverable.
      fidelity =
        compressedText === payload.content
          ? { kind: 'not-compressed' }
          : { kind: 'no-handle', bytesDropped: payload.content.length - compressedText.length };
    } else {
      fidelity = await checkRoundTrip(adapter, handle, payload.content);
    }
  }

  return {
    payloadId: payload.id,
    workloadId: workload.id,
    kind: payload.kind,
    callSite: 'conductor-dispatch',
    bytesBefore: payload.content.length,
    accepted,
    stats: live.value.stats,
    latencyMs: live.ms,
    baselineLatencyMs: baseline.ms,
    fidelity,
  };
}

/** Redeem a handle and compare bytes. Never throws. */
async function checkRoundTrip(
  adapter: HeadroomAdapter,
  handle: string,
  original: string,
): Promise<FidelityOutcome> {
  const result = await adapter.retrieve(handle);
  if (!result.retrieved) {
    return { kind: 'retrieve-failed', handle, reason: result.reason };
  }
  if (result.content === original) return { kind: 'round-trip-identical', handle };
  return { kind: 'round-trip-differs', handle, retrievedBytes: result.content.length };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

async function runPass(
  options: Options,
  workloads: readonly BenchmarkWorkload[],
  proxy: ProxyHandle,
): Promise<BenchmarkReport> {
  const adapter = await createHeadroomAdapter({
    enabled: true,
    baseUrl: proxy.baseUrl,
    model: options.model,
  });

  if (adapter.kind !== 'sdk') {
    throw new Error(
      `the boundary returned the ${adapter.kind} adapter, not the SDK one — ` +
        'there is nothing real to measure. Check that headroom-ai is installed and the proxy is reachable.',
    );
  }

  const noop = createNoopHeadroomAdapter('disabled');

  // One discarded call before any timing. The proxy loads its compressors on
  // first use, and that cost is real but is a *start-up* cost, not the
  // per-call overhead a rollout decision turns on. Measuring it into p95 would
  // overstate the steady-state price by an order of magnitude; ignoring it
  // silently would understate the first turn of a session. So it is paid here
  // and reported separately.
  const warmup = await timed(() =>
    adapter.compress({
      messages: [{ role: 'assistant', content: 'warm up the proxy\n'.repeat(256) }],
      model: options.model,
    }),
  );
  console.log(`  (warm-up call: ${warmup.ms.toFixed(0)}ms, discarded)`);

  const measurements: PayloadMeasurement[] = [];
  const summaries: WorkloadSummary[] = [];

  for (const workload of workloads) {
    const sampled = workload.payloads.slice(0, options.maxPayloadsPerWorkload);
    if (sampled.length === 0) continue;

    summaries.push({
      id: workload.id,
      kind: workload.kind,
      source: workload.source,
      sha256: sha256(sampled.map((p) => p.content)),
      payloads: sampled.length,
      bytes: sampled.reduce((sum, p) => sum + p.content.length, 0),
    });

    for (const payload of sampled) {
      // Each payload is measured through the call site its kind actually
      // reaches in the product — never through both, which would double-count.
      const measurement =
        workload.kind === 'session-transcript'
          ? await measureSessionLoop(adapter, noop, workload, payload)
          : await measureConductor(adapter, noop, workload, payload, options.model);
      measurements.push(measurement);

      const label = `${workload.id}/${payload.id}`;
      const savings = describeStats(measurement.stats);
      console.log(
        `  ${measurement.accepted ? 'accepted ' : 'passed   '} ${label.padEnd(48).slice(0, 48)} ` +
          `${String(measurement.bytesBefore).padStart(8)}B  ${savings}  ${measurement.latencyMs.toFixed(0)}ms  ${measurement.fidelity.kind}`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    adapterKind: adapter.kind,
    baseUrl: proxy.baseUrl,
    sdkVersion: readSdkVersion(),
    proxyVersion: proxy.version,
    profile: proxy.profile,
    warmupMs: warmup.ms,
    workloads: summaries,
    measurements,
  };
}

function describeStats(stats: HeadroomMeasurement<HeadroomCompressStats>): string {
  if (!stats.available) return `stats absent (${stats.reason})`.padEnd(34);
  const { tokensBefore, tokensAfter } = stats.value;
  return `${String(tokensBefore).padStart(7)}→${String(tokensAfter).padStart(7)} tok`.padEnd(34);
}

function readSdkVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'packages', 'shared', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    return manifest.dependencies?.['headroom-ai'] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const sessionPaths =
    options.sessions.length > 0
      ? options.sessions
      : discoverSessions(options.workspace, options.maxSessions);
  const runPaths =
    options.runs.length > 0 ? options.runs : discoverRuns(options.workspace, 1);

  if (sessionPaths.length === 0) {
    throw new Error(`no session transcripts found under ${options.workspace}/sessions`);
  }
  if (runPaths.length === 0) {
    throw new Error(`no Conductor runs found under ${options.workspace}/tasks`);
  }

  const workloads = [
    ...sessionPaths.map((p) => loadSessionWorkload(p, options.minPayloadBytes)),
    ...runPaths.map((p) => loadRunWorkload(p, options.minPayloadBytes)),
  ].filter((w) => w.payloads.length > 0);

  console.log(
    `Workloads: ${workloads.length} (${workloads.filter((w) => w.kind === 'session-transcript').length} transcripts, ` +
      `${workloads.filter((w) => w.kind === 'workflow-run').length} runs), ` +
      `${workloads.reduce((n, w) => n + Math.min(w.payloads.length, options.maxPayloadsPerWorkload), 0)} payloads sampled`,
  );

  const reports: BenchmarkReport[] = [];

  for (const [index, profile] of options.profiles.entries()) {
    let proxy: ProxyHandle;
    if (options.spawnProxy) {
      const port = 8900 + index;
      console.log(`\n[${profile}] starting a proxy on port ${port} …`);
      proxy = await startProxy(profile, port);
    } else {
      const version = await waitForProxy(options.baseUrl, 10_000);
      proxy = {
        baseUrl: options.baseUrl,
        version,
        profile: await proxyProfile(options.baseUrl, profile),
        stop: () => {},
      };
      console.log(`\n[${proxy.profile}] using the proxy already running at ${options.baseUrl}`);
    }

    try {
      reports.push(await runPass(options, workloads, proxy));
    } finally {
      proxy.stop();
    }
  }

  const markdown = reports.map(renderReportMarkdown).join('\n\n---\n\n');

  if (options.outJson) {
    writeFileSync(options.outJson, `${JSON.stringify(reports, null, 2)}\n`);
    console.log(`\nwrote ${options.outJson}`);
  }
  if (options.outMarkdown) {
    writeFileSync(options.outMarkdown, `${markdown}\n`);
    console.log(`wrote ${options.outMarkdown}`);
  }
  if (!options.outJson && !options.outMarkdown) {
    console.log(`\n${markdown}`);
  }
}

main().catch((error: unknown) => {
  console.error(`benchmark-headroom: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
