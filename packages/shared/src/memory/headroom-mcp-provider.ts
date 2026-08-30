/**
 * `headroom-mcp` — Headroom's memory, behind the vendor-neutral seam
 * (fork: PLAN-040 / SUV-0029; surface decided by ADR-0029, demoted to one
 * provider by ADR-0031).
 *
 * ## This file is a boundary, like `headroom/sdk-adapter.ts`
 *
 * It is the **only** file in `apps/` or `packages/` permitted to name
 * Headroom's memory subprocess. `scripts/check-headroom-boundary.ts` enforces
 * that with a second pattern added for exactly this reason: the original gate
 * matches package *imports*, so it is structurally blind to
 * `python -m headroom.memory.mcp_server` being spawned from anywhere. Without
 * the second pattern the boundary held in one direction only, and this file is
 * precisely the one that introduces the other.
 *
 * ## Why a subprocess and not the SDK
 *
 * `headroom-ai@0.36.5` has no memory API at all — no endpoint, no client
 * member, no filesystem access, and no mention of memory in its README. Three
 * separate audit passes established this, and
 * `headroom/__tests__/sdk-memory-surface.test.ts` pins it so an upstream change
 * turns the monthly bump red. Memory ships in the matched *Python* half of the
 * product as a stdio MCP server, which upstream's own `headroom wrap` writes
 * into generated MCP config. That is the surface ADR-0029 chose, driven over
 * real stdio JSON-RPC before it was chosen.
 *
 * ## The three constraints this surface imposes, declared not hidden
 *
 * All three are reported by `describe()` so the host degrades around them
 * instead of assuming Headroom's shape at a call site:
 *
 * - **C1 — installed is not working.** The ONNX embedder needs
 *   `Qdrant/all-MiniLM-L6-v2-onnx` (~86 MB) from HuggingFace, while the server
 *   sets `HF_HUB_OFFLINE=1`. Uncached, it handshakes correctly and advertises
 *   both tools while both tool calls fail. That is the `unprovisioned` state,
 *   and it is why `MemoryProviderState` has three values rather than two.
 * - **C2 — four-layer scoping collapses to USER.** The save handler passes only
 *   content, user and importance; `session_id`/`agent_id`/`turn_id` are NULL on
 *   disk. `scopeLayers` therefore reports `['user']`, not the four upstream
 *   advertises.
 * - **C3 — reads are prose.** `memory_search` returns
 *   `"1. [relevance=0.50] <content>"`, so every record this provider returns
 *   carries `structured: false` and everything beyond content and relevance is
 *   best-effort parsing.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  memoryAvailable,
  memoryUnavailable,
  type MemoryProvider,
  type MemoryProviderCapabilities,
  type MemoryProviderState,
  type MemoryRecord,
  type MemoryResult,
  type MemorySaveRequest,
  type MemorySearchRequest,
} from '@craft-agent/core/types';

import { CraftMcpClient } from '../mcp/client.ts';
import { debug } from '../utils/debug.ts';
import { MEMORY_DIR_NAME } from './markdown-store.ts';

export const HEADROOM_MCP_PROVIDER_ID = 'headroom-mcp';

/**
 * The database file this provider pins Headroom to, inside the workspace's
 * `memory/` folder — the same folder the built-in provider uses, so "where are
 * my memories" has one answer regardless of which provider wrote them.
 */
export const HEADROOM_DB_FILE = 'headroom-memory.db';

/**
 * The Python module that serves Headroom's memory over stdio.
 *
 * Assembled from parts rather than written whole for the same reason
 * `check-headroom-boundary.ts` assembles the package name: so the boundary
 * gate's own source, and the tripwire tests that grep for this string, are not
 * themselves violations of the rule they enforce.
 */
const MEMORY_MODULE = ['headroom', 'memory', 'mcp_server'].join('.');

const SEARCH_TOOL = 'memory_search';
const SAVE_TOOL = 'memory_save';

/** How long any single MCP operation may take before we call it unavailable. */
const OPERATION_TIMEOUT_MS = 20_000;

export interface HeadroomMcpProviderOptions {
  readonly workspaceRootPath: string;
  readonly topK: number;
  /** Overrides interpreter discovery. Mainly a test seam. */
  readonly pythonPath?: string;
  /** User id for the single scoping layer this surface honours (C2). */
  readonly userId?: string;
}

/**
 * Find an interpreter that can import the memory module.
 *
 * Ordered most-specific first. The `uv` tool path is checked before bare
 * `python3` because Headroom installs there by default and a system `python3`
 * will usually *not* have the package — falling through to it would report
 * "absent" on a machine where Headroom is installed and working, which is the
 * least useful possible diagnosis.
 *
 * Returns `null` when nothing plausible exists, which the caller reports as the
 * `absent` state.
 */
export function resolveHeadroomPython(explicit?: string): string | null {
  const exists = (candidate: string): boolean => {
    try {
      return existsSync(candidate);
    } catch {
      // An unreadable path is not a usable interpreter.
      return false;
    }
  };

  // An explicit path is **authoritative, not a first guess**. Falling through
  // to discovery when the caller named an interpreter would mean quietly
  // running a different Python than the one asked for — which in a test reads
  // as a passing assertion about the wrong subject, and in production means a
  // user's `VORNO_HEADROOM_PYTHON` is honoured only when it happens to work.
  if (typeof explicit === 'string' && explicit !== '') {
    return exists(explicit) ? explicit : null;
  }
  const fromEnv = process.env.VORNO_HEADROOM_PYTHON;
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return exists(fromEnv) ? fromEnv : null;
  }

  for (const candidate of [
    join(homedir(), '.local', 'share', 'uv', 'tools', 'headroom-ai', 'bin', 'python'),
    join(homedir(), '.local', 'share', 'uv', 'tools', 'headroom-ai', 'bin', 'python3'),
  ]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function flattenToolText(result: unknown): { text: string; isError: boolean } {
  const typed = (result ?? {}) as McpToolCallResult;
  const text = (typed.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  return { text, isError: typed.isError === true };
}

/**
 * Parse `memory_search`'s prose into records (C3).
 *
 * The wire format is `"1. [relevance=0.50] <content>"`, one per line. Anything
 * that does not match that shape is kept as a record with relevance 0 rather
 * than dropped: losing a memory because upstream reformatted its output is a
 * worse failure than ranking one poorly.
 */
export function parseHeadroomSearchProse(text: string): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  for (const [index, line] of lines.entries()) {
    const match = /^(\d+)\.\s*\[relevance=([0-9.]+)\]\s*(.*)$/.exec(line);
    if (match) {
      const relevance = Number(match[2]);
      out.push({
        id: `headroom-mcp:${match[1]}`,
        content: (match[3] ?? '').trim(),
        relevance: Number.isFinite(relevance) ? Math.min(1, Math.max(0, relevance)) : 0,
        structured: false,
      });
      continue;
    }
    // No "no results" sentinel is documented, so a non-matching line is treated
    // as content only when it plausibly is content.
    if (/^(no |none|0 )/i.test(line)) continue;
    out.push({
      id: `headroom-mcp:unparsed-${index}`,
      content: line,
      relevance: 0,
      structured: false,
    });
  }

  return out;
}

/**
 * Does this error text describe the missing-embedder state (ADR-0029 C1)?
 *
 * Matched on substrings rather than an error code because upstream does not
 * give us one — the server returns `isError: true` with prose. Deliberately
 * conservative: an unrecognised error is reported as `absent` with the server's
 * own message attached, not optimistically as "just needs a download". Guessing
 * wrong in that direction sends a user to fetch 86 MB that will not help.
 */
export function looksLikeMissingEmbedder(text: string): boolean {
  const haystack = (text ?? '').toLowerCase();
  return (
    haystack.includes('hf_hub_offline') ||
    haystack.includes('huggingface') ||
    haystack.includes('embedder') ||
    haystack.includes('embedding model') ||
    haystack.includes('all-minilm') ||
    (haystack.includes('model') && haystack.includes('not found')) ||
    (haystack.includes('model') && haystack.includes('offline'))
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HeadroomMcpMemoryProvider implements MemoryProvider {
  readonly id = HEADROOM_MCP_PROVIDER_ID;

  private client: CraftMcpClient | null = null;
  private capabilities: MemoryProviderCapabilities | null = null;
  private probing: Promise<MemoryProviderCapabilities> | null = null;

  constructor(private readonly options: HeadroomMcpProviderOptions) {}

  /** Where this workspace's Headroom memory database lives. */
  getDatabasePath(): string {
    return join(this.options.workspaceRootPath, MEMORY_DIR_NAME, HEADROOM_DB_FILE);
  }

  private buildClient(pythonPath: string): CraftMcpClient {
    // `--db` is passed explicitly, and that is load-bearing. Left to itself the
    // server resolves its database **from the current working directory**
    // (`config_source=cwd-default`), which for a desktop app is wherever the
    // process happened to be launched from — so memory would silently land in a
    // different store depending on how Vorno was started, and could scatter
    // `.headroom/` directories into unrelated folders. Naming the path makes
    // the store a property of the workspace, which is what a user means by
    // "my memories".
    const dbPath = this.getDatabasePath();
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (error) {
      // Let the server report the failure through its own error path rather
      // than turning a directory problem into a construction throw.
      debug('[memory] could not prepare Headroom db directory:', error);
    }

    return new CraftMcpClient({
      transport: 'stdio',
      command: pythonPath,
      args: [
        '-m',
        MEMORY_MODULE,
        '--db',
        dbPath,
        ...(this.options.userId ? ['--user', this.options.userId] : []),
      ],
      env: {
        // Headroom's own default. Set explicitly rather than inherited so the
        // provisioning state is a property of our invocation, not of whatever
        // happened to be in the user's shell.
        HF_HUB_OFFLINE: '1',
      },
    });
  }

  /**
   * Connect, list tools, and probe whether the tools actually work.
   *
   * The probe is what distinguishes `unprovisioned` from `ready`, and it cannot
   * be skipped: in the unprovisioned state the server handshakes correctly and
   * advertises both tools. A capability check that stopped at `tools/list`
   * would report `ready` for a provider on which every call fails.
   *
   * Cached after the first run. Provisioning does not change under us within a
   * session, and re-probing on every `describe()` would spawn a Python process
   * per settings-panel render.
   */
  private async probe(): Promise<MemoryProviderCapabilities> {
    if (this.capabilities) return this.capabilities;
    if (this.probing) return this.probing;

    this.probing = (async (): Promise<MemoryProviderCapabilities> => {
      const pythonPath = resolveHeadroomPython(this.options.pythonPath);
      if (!pythonPath) {
        return this.buildCapabilities('absent', [
          'Headroom is not installed on this machine, or its Python environment could not be found.',
          'Install it with `uv tool install headroom-ai`, or set VORNO_HEADROOM_PYTHON to an interpreter that can import Headroom.',
        ]);
      }

      try {
        const client = this.buildClient(pythonPath);
        const tools = await withTimeout(client.listTools(), OPERATION_TIMEOUT_MS, 'tools/list');
        const names = new Set(tools.map((tool) => tool.name));
        if (!names.has(SEARCH_TOOL) || !names.has(SAVE_TOOL)) {
          await client.close().catch(() => {});
          return this.buildCapabilities('absent', [
            `Headroom's memory server did not advertise ${SEARCH_TOOL} and ${SAVE_TOOL}.`,
          ]);
        }

        // The C1 probe. A cheap search; we care only whether it errors.
        const probeResult = await withTimeout(
          client.callTool(SEARCH_TOOL, { query: 'vorno provisioning probe', limit: 1 }),
          OPERATION_TIMEOUT_MS,
          `${SEARCH_TOOL} probe`,
        );
        const { isError, text } = flattenToolText(probeResult);

        this.client = client;

        if (isError) {
          // Not every failing probe is a provisioning problem, and reporting
          // one as the other is exactly the `describe()` dishonesty ADR-0031
          // warns about: a capability flag that drifts from provider reality is
          // worse than no flag. "Unprovisioned" means specifically *the
          // embedder model is missing* — the C1 state, fixable by one download.
          // A database that will not open is a different problem with a
          // different fix, and telling the user to download a model would send
          // them to the wrong place entirely.
          if (looksLikeMissingEmbedder(text)) {
            return this.buildCapabilities('unprovisioned', [
              'Headroom is installed and its memory server is running, but its embedding model is not downloaded yet, so searches and saves fail.',
              'This is a one-time ~86 MB download from HuggingFace. Run `headroom memory stats` once with network access to fetch it.',
              text ? `Server said: ${text}` : '',
            ].filter(Boolean));
          }

          return this.buildCapabilities('absent', [
            "Headroom's memory server started but its backend is not usable.",
            text ? `Server said: ${text}` : '',
          ].filter(Boolean));
        }

        return this.buildCapabilities('ready', []);
      } catch (error) {
        debug('[memory] headroom-mcp probe failed:', error);
        return this.buildCapabilities('absent', [
          `Could not start Headroom's memory server: ${String(error)}`,
        ]);
      }
    })();

    this.capabilities = await this.probing;
    this.probing = null;
    return this.capabilities;
  }

  private buildCapabilities(
    state: MemoryProviderState,
    extraNotes: readonly string[],
  ): MemoryProviderCapabilities {
    return {
      providerId: this.id,
      state,
      summary:
        state === 'ready'
          ? 'Headroom memory (semantic search over a local SQLite store).'
          : state === 'unprovisioned'
            ? 'Headroom is installed but its embedding model has not been downloaded.'
            : 'Headroom is not available on this machine.',
      search: 'semantic',
      // C2, stated honestly: upstream advertises four layers; this surface
      // writes NULL to three of them.
      scopeLayers: ['user'],
      // C3.
      structuredReads: false,
      supersession: false,
      decay: false,
      archive: false,
      retrievalLog: false,
      requiresProvisioning: true,
      egress: 'first-run-model-fetch',
      notes: [
        'Scoping collapses to a single user layer — memories are not separated per session, agent, or turn.',
        'Results come back as formatted text rather than structured records, so tags, timestamps, and importance are not available on reads.',
        'Enabling this provider downloads an embedding model (~86 MB) from HuggingFace once. Nothing else leaves your machine.',
        ...extraNotes,
      ],
    };
  }

  private async ready(): Promise<{ client: CraftMcpClient } | MemoryResult<never>> {
    const capabilities = await this.probe();
    if (capabilities.state === 'unprovisioned') {
      return memoryUnavailable<never>('provider-unprovisioned', capabilities.notes.join(' '));
    }
    if (capabilities.state !== 'ready' || !this.client) {
      return memoryUnavailable<never>('provider-absent', capabilities.notes.join(' '));
    }
    return { client: this.client };
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult<readonly MemoryRecord[]>> {
    const gate = await this.ready();
    if (!('client' in gate)) return gate as MemoryResult<readonly MemoryRecord[]>;

    try {
      const result = await withTimeout(
        gate.client.callTool(SEARCH_TOOL, {
          query: request.query,
          limit: Math.max(1, request.topK ?? this.options.topK ?? 5),
        }),
        OPERATION_TIMEOUT_MS,
        SEARCH_TOOL,
      );
      const { isError, text } = flattenToolText(result);
      if (isError) return memoryUnavailable('provider-error', text || 'memory_search failed');
      return memoryAvailable(parseHeadroomSearchProse(text));
    } catch (error) {
      debug('[memory] headroom-mcp search failed:', error);
      return memoryUnavailable('provider-error', String(error));
    }
  }

  async save(request: MemorySaveRequest): Promise<MemoryResult<readonly string[]>> {
    const gate = await this.ready();
    if (!('client' in gate)) return gate as MemoryResult<readonly string[]>;

    const ids: string[] = [];
    try {
      for (const fact of request.facts) {
        const content = (fact.content ?? '').trim();
        if (content === '') continue;
        const result = await withTimeout(
          gate.client.callTool(SAVE_TOOL, {
            content,
            // The one scoping layer this surface honours (C2). Everything else
            // the seam can express is dropped here, which `describe()` says.
            ...(this.options.userId ? { user_id: this.options.userId } : {}),
            ...(typeof fact.importance === 'number' ? { importance: fact.importance } : {}),
          }),
          OPERATION_TIMEOUT_MS,
          SAVE_TOOL,
        );
        const { isError, text } = flattenToolText(result);
        if (isError) return memoryUnavailable('provider-error', text || 'memory_save failed');
        // Upstream returns prose rather than an id. Synthesising one would be
        // fabricating data the source did not provide, so the echoed text is
        // the identifier we have.
        ids.push(text || `${this.id}:saved-${ids.length}`);
      }
      return memoryAvailable(ids);
    } catch (error) {
      debug('[memory] headroom-mcp save failed:', error);
      return memoryUnavailable('provider-error', String(error));
    }
  }

  async describe(): Promise<MemoryProviderCapabilities> {
    return this.probe();
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.capabilities = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      debug('[memory] headroom-mcp dispose failed:', error);
    }
  }
}

export function createHeadroomMcpProvider(
  options: HeadroomMcpProviderOptions,
): HeadroomMcpMemoryProvider {
  return new HeadroomMcpMemoryProvider(options);
}
