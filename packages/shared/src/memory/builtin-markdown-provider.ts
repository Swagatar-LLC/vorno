/**
 * `builtin-markdown` — the default memory provider
 * (fork: PLAN-040 / SUV-0029 minimal slice, SUV-0040 build-out; ADR-0031).
 *
 * Markdown files with frontmatter, lexical retrieval weighted by decay and
 * importance, archive-on-decay, and a retrieval log. **No Python, no model
 * download, no provider key, no network access, ever** — a bounded provider
 * implementation, not a memory platform, carved out of PLAN-040's first
 * non-goal deliberately and narrowly by ADR-0031 commitment 4.
 *
 * ## What this provider is *for*
 *
 * Being the default. ADR-0029's constraint C1 — "installed but unprovisioned",
 * where Headroom's memory server handshakes correctly and advertises both tools
 * while both tool calls fail for want of an ~86 MB embedder model — is a state
 * this provider **cannot occupy**. There is nothing to provision. That is the
 * entire argument for it existing, and it is why `describe()` reports
 * `requiresProvisioning: false` and `egress: 'none'` as facts rather than
 * aspirations: both are asserted by test.
 *
 * ## What it is not
 *
 * Semantic. See `lexical.ts`. `describe().notes` says so in the provider's own
 * words and names `headroom-mcp` as the alternative, because a capability flag
 * that flatters the provider is worse than no flag at all.
 *
 * ## Behaviours inherited from the agentic-memory engine
 *
 * SUV-0040 asks for that engine's proven semantics *as provider behaviours
 * behind the seam*, not as a second engine. Four of them land here:
 *
 * - **Gated loads** — memory enters context only at host-invoked lifecycle
 *   points (`session-memory.ts`), never because the model asked.
 * - **Logged retrieval** — every read appends a line naming what was loaded,
 *   what was trimmed, and what was kept.
 * - **PRG-style trims** — the scope trim runs *after* retrieval and before use.
 * - **Archive markers** — decayed memories move to cold storage carrying a
 *   banner. Nothing is ever deleted.
 */

import {
  memoryAvailable,
  memoryUnavailable,
  type MemoryProvider,
  type MemoryProviderCapabilities,
  type MemoryRecord,
  type MemoryResult,
  type MemorySaveRequest,
  type MemoryScope,
  type MemorySearchRequest,
} from '@craft-agent/core/types';

import { debug } from '../utils/debug.ts';
import { bandFor, normalizeImportance, rankingScore, temporalWeight } from './decay.ts';
import { applyScopeTrim, lexicalScore, prepareQuery } from './lexical.ts';
import { buildMemoryId, type MemoryFileEntry } from './memory-file.ts';
import {
  appendRetrievalLog,
  archiveMemoryEntry,
  readMemoryEntries,
  recordCitations,
  resolveMemoryStorePaths,
  writeMemoryEntry,
  type MemoryStorePaths,
} from './markdown-store.ts';

export const BUILTIN_MARKDOWN_PROVIDER_ID = 'builtin-markdown';

/** Construction inputs. Everything injectable is injected, so tests are hermetic. */
export interface BuiltinMarkdownProviderOptions {
  readonly workspaceRootPath: string;
  /** Base half-life in days, from resolved `MemoryConfig`. */
  readonly halfLifeDays: number;
  /** Default result cap when a request does not specify one. */
  readonly topK: number;
  /** Whether searches may reach cold storage. Requests can narrow, not widen. */
  readonly includeArchived: boolean;
  /** Injected clock. Defaults to the real one; tests pass a fixed instant. */
  readonly now?: () => number;
  /** Injected id entropy, for the same reason. */
  readonly randomSuffix?: () => string;
}

/** Hard ceiling on results, regardless of what a caller asks for. */
const MAX_TOP_K = 50;

/**
 * A memory whose lexical score falls below this never appears, however fresh or
 * important it is.
 *
 * Without a floor, decay and importance would promote *irrelevant* memories
 * into context whenever a query matched nothing well — and a memory system
 * whose failure mode is confidently supplying the wrong context is worse than
 * one that supplies none.
 */
const MIN_LEXICAL_SCORE = 0.2;

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class BuiltinMarkdownMemoryProvider implements MemoryProvider {
  readonly id = BUILTIN_MARKDOWN_PROVIDER_ID;

  private readonly paths: MemoryStorePaths;
  private readonly now: () => number;
  private readonly randomSuffix: () => string;

  constructor(private readonly options: BuiltinMarkdownProviderOptions) {
    this.paths = resolveMemoryStorePaths(options.workspaceRootPath);
    this.now = options.now ?? (() => Date.now());
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  }

  /** Exposed for tests and for a future settings surface that shows the store. */
  getStorePaths(): MemoryStorePaths {
    return this.paths;
  }

  async search(request: MemorySearchRequest): Promise<MemoryResult<readonly MemoryRecord[]>> {
    try {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();

      // A request may narrow cold-storage access but never widen it: config is
      // the ceiling. Otherwise any call site could reach into the archive by
      // passing a flag, and "reachable only on purpose" would depend on every
      // caller's discipline instead of on one setting.
      const includeArchived = this.options.includeArchived && request.includeArchived !== false;

      const all = readMemoryEntries(this.paths, { includeArchived });
      const { kept: inScope, trimmed } = applyScopeTrim(all, request.scope);

      const query = prepareQuery(request.query);
      const limit = Math.min(
        MAX_TOP_K,
        Math.max(1, request.topK ?? this.options.topK ?? 5),
      );

      const scored = inScope
        .map((entry) => {
          const lexical = lexicalScore(query, entry);
          const weight = temporalWeight(entry, this.options.halfLifeDays, nowMs);
          return {
            entry,
            lexical,
            relevance: rankingScore(lexical, weight.score, entry.importance),
          };
        })
        .filter((candidate) => candidate.lexical >= MIN_LEXICAL_SCORE)
        .sort((a, b) => {
          if (b.relevance !== a.relevance) return b.relevance - a.relevance;
          // Deterministic tie-break so identical corpora rank identically across
          // machines — readdir order is not a guarantee.
          return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
        })
        .slice(0, limit);

      const records = scored.map(({ entry, relevance }) => toRecord(entry, relevance));

      appendRetrievalLog(this.paths, {
        ts: nowIso,
        query: request.query,
        provider: this.id,
        target: {
          scope: scopeToRecord(request.scope),
          destination: 'main-context',
        },
        loaded: all.length,
        trimmed: trimmed + (inScope.length - scored.length),
        kept: records.map((record) => record.id),
      });

      // Reinforcement: being cited resets the decay clock. This is the write
      // that makes `search` non-pure, and it is intentional — a read-only
      // search cannot distinguish a memory that keeps earning its tokens from
      // one nobody has wanted in a year.
      recordCitations(
        this.paths,
        scored.map(({ entry }) => entry).filter((entry) => !entry.archivedAt),
        nowIso,
      );

      return memoryAvailable(records);
    } catch (error) {
      debug('[memory] builtin-markdown search failed:', error);
      return memoryUnavailable('provider-error', String(error));
    }
  }

  async save(request: MemorySaveRequest): Promise<MemoryResult<readonly string[]>> {
    try {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const ids: string[] = [];

      for (const fact of request.facts) {
        const content = (fact.content ?? '').trim();
        if (content === '') continue;

        const entry: MemoryFileEntry = {
          id: buildMemoryId(nowMs + ids.length, this.randomSuffix()),
          content,
          createdAt: nowIso,
          updatedAt: nowIso,
          importance: normalizeImportance(fact.importance),
          tags: [...(fact.tags ?? [])],
          scope: request.scope ?? {},
          citations: 0,
        };

        if (writeMemoryEntry(this.paths, entry)) ids.push(entry.id);
      }

      // The decay sweep runs on write, not on read. Two reasons: a save is
      // already a write, so archiving costs no extra I/O turn; and a sweep on
      // every search would make retrieval latency scale with corpus size for a
      // job that only needs to happen occasionally.
      this.sweep(nowIso);

      return memoryAvailable(ids);
    } catch (error) {
      debug('[memory] builtin-markdown save failed:', error);
      return memoryUnavailable('provider-error', String(error));
    }
  }

  /**
   * Move every archive-candidate memory into cold storage.
   *
   * Public so tests can drive it at a fixed instant, and so a future settings
   * action ("tidy memory now") has something to call. Returns the ids archived.
   */
  sweep(nowIso?: string): string[] {
    const nowMs = this.now();
    const stamp = nowIso ?? new Date(nowMs).toISOString();
    const archived: string[] = [];

    for (const entry of readMemoryEntries(this.paths, { includeArchived: false })) {
      const weight = temporalWeight(entry, this.options.halfLifeDays, nowMs);
      if (weight.pinned) continue;
      if (bandFor(weight.score) !== 'archive-candidate') continue;
      const reason = `decayed out (score ${weight.score.toFixed(3)} after ${Math.round(weight.ageDays)}d)`;
      if (archiveMemoryEntry(this.paths, entry, reason, stamp)) archived.push(entry.id);
    }

    if (archived.length > 0) debug('[memory] archived on sweep:', archived.join(', '));
    return archived;
  }

  async describe(): Promise<MemoryProviderCapabilities> {
    return {
      providerId: this.id,
      state: 'ready',
      summary: 'Markdown files in your workspace. No setup, nothing leaves your machine.',
      // The single most important honest flag on this object.
      search: 'lexical',
      // All four layers are honoured natively — unlike headroom-mcp, which
      // collapses to USER (ADR-0029 C2).
      scopeLayers: ['user', 'session', 'agent', 'turn'],
      // Reads are typed records off parsed frontmatter, not prose (cf. C3).
      structuredReads: true,
      // Not implemented: ADR-0029 commitment 2 keeps supersession off the seam
      // until every provider can honour it. The frontmatter carries a
      // `supersedes` field so the format is ready when the verb arrives.
      supersession: false,
      decay: true,
      archive: true,
      retrievalLog: true,
      // The point of it being the default. C1 cannot happen here.
      requiresProvisioning: false,
      egress: 'none',
      notes: [
        'Retrieval is lexical (words, tags, and recency) — not semantic. Memories phrased differently from your query may be missed; the "Headroom (MCP)" provider does semantic search instead.',
        'Memories are plain markdown under your workspace\'s memory/ folder — readable, greppable, and editable by hand.',
        'Old memories are archived, never deleted, and archived memories are excluded from searches unless you ask for them.',
        'Every retrieval is logged to memory/retrieval-log.jsonl (ids and counts, never content).',
      ],
    };
  }
}

function scopeToRecord(scope: MemoryScope | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scope ?? {})) {
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

function toRecord(entry: MemoryFileEntry, relevance: number): MemoryRecord {
  return {
    id: entry.id,
    content: entry.content,
    relevance,
    structured: true,
    importance: entry.importance,
    tags: [...entry.tags],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    scope: entry.scope,
    ...(entry.archivedAt ? { archived: true } : {}),
    ...(entry.path ? { source: entry.path } : {}),
  };
}

/** Factory mirroring the other providers, so the registry never uses `new`. */
export function createBuiltinMarkdownProvider(
  options: BuiltinMarkdownProviderOptions,
): BuiltinMarkdownMemoryProvider {
  return new BuiltinMarkdownMemoryProvider(options);
}
