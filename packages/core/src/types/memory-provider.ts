/**
 * The vendor-neutral memory provider contract (fork: PLAN-040 / SUV-0029,
 * decided by ADR-0031).
 *
 * Memory in Vorno is a **capability with providers**, not a feature of any one
 * vendor. `HeadroomAdapter` is `{ kind, compress, retrieve, stats }` — shaped
 * around compression, named for a vendor. Bolting `memorySearch`/`memorySave`
 * onto it would have made every future engine swap a migration through the
 * Headroom boundary module, the Headroom config schema, and the Headroom
 * settings section. ADR-0031 names this seam instead; Headroom is one provider
 * behind it (`headroom-mcp`), the built-in markdown store is another
 * (`builtin-markdown`), and swapping between them is a config change that
 * touches no call site.
 *
 * Four invariants, inherited deliberately from `headroom-adapter.ts` because
 * they are what made that boundary hold:
 *
 * - **Import-free plain data.** This file imports nothing. Every type here
 *   survives `JSON.parse(JSON.stringify(...))`, so a server-hosted instance can
 *   put the identical shape on the wire.
 * - **Measured or absent, never interpolated.** {@link MemoryResult} has an
 *   unavailable arm carrying a *reason*. A provider that cannot answer says so;
 *   it does not return an empty array that reads like "no memories exist".
 * - **Non-throwing by contract.** No {@link MemoryProvider} method may reject.
 *   Memory is an enrichment; a memory failure must never take down a session.
 * - **Capabilities are declared, not assumed.** {@link MemoryProvider.describe}
 *   exists because ADR-0029's constraints C1/C2/C3 proved that providers have
 *   shapes the host must degrade around rather than hardcode. Every flag on
 *   {@link MemoryProviderCapabilities} is a claim that must have a test against
 *   the real provider behind it — capability flags that drift from provider
 *   reality are worse than no flags at all.
 *
 * **Host-invoked.** Providers are called by the host at deterministic lifecycle
 * points — session context load, save points, Conductor node dispatch — never
 * contingent on the model electing to call a tool. That is ADR-0029's
 * commitment 1, generalized: because we own the call site, a future host can
 * fan `search` across providers and merge, or write to one and mirror to
 * another. Model-invoked tools cannot be composed deterministically.
 */

/**
 * The scoping layers upstream memory engines advertise, most general first.
 *
 * Modelled as four because that is the vocabulary the ecosystem uses (Headroom
 * advertises USER → SESSION → AGENT → TURN). A provider declares which of them
 * it actually honours via {@link MemoryProviderCapabilities.scopeLayers}; the
 * seam can express more than a given provider stores, and `describe()` is what
 * keeps that gap visible instead of silently truncated (ADR-0029 C2 — Headroom's
 * MCP surface writes NULL to three of these four columns).
 */
export type MemoryScopeLayer = 'user' | 'session' | 'agent' | 'turn';

export const MEMORY_SCOPE_LAYERS: readonly MemoryScopeLayer[] = [
  'user',
  'session',
  'agent',
  'turn',
];

/**
 * Where a memory belongs, or which slice of memory a search is asking about.
 *
 * Every field is optional and every field is a plain string id. An absent field
 * means "unscoped at this layer", which for a search widens the result set and
 * for a save means the memory is not pinned to that layer.
 */
export interface MemoryScope {
  readonly user?: string;
  readonly session?: string;
  readonly agent?: string;
  readonly turn?: string;
}

/**
 * One thing worth remembering, as handed to {@link MemoryProvider.save}.
 *
 * `importance` is a 0..1 hint, not a rank: providers that support weighting use
 * it, providers that do not ignore it, and `describe()` says which. Tags are
 * free-form lowercase strings; the built-in provider indexes them, the Headroom
 * MCP surface discards them (C3 territory).
 */
export interface MemoryFact {
  readonly content: string;
  readonly importance?: number;
  readonly tags?: readonly string[];
}

/** A search, as issued by the host. */
export interface MemorySearchRequest {
  readonly query: string;
  readonly scope?: MemoryScope;
  /** Maximum results wanted. Providers may return fewer, never more. */
  readonly topK?: number;
  /**
   * Include archived (decayed-out) memories.
   *
   * Default `false`, and that default is load-bearing: an archive that still
   * loads is not an archive, it is a rename. Cold storage is reachable on
   * purpose, never by accident.
   */
  readonly includeArchived?: boolean;
}

/** A save, as issued by the host. */
export interface MemorySaveRequest {
  readonly facts: readonly MemoryFact[];
  readonly scope?: MemoryScope;
}

/**
 * One retrieved memory.
 *
 * `relevance` is whatever the provider's ranking produced, normalized to 0..1.
 * It is comparable *within* one provider's result set and not across providers
 * — a lexical score and a cosine similarity are not the same quantity, and the
 * seam does not pretend otherwise.
 *
 * `structured` is the honest flag for ADR-0029 C3: a provider whose reads are
 * prose (`"1. [relevance=0.50] <content>"`) sets it `false`, and everything
 * except `content` and `relevance` on such a record is best-effort.
 */
export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly relevance: number;
  readonly structured: boolean;
  readonly importance?: number;
  readonly tags?: readonly string[];
  /** ISO-8601 date or date-time, provider's own stamp. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly scope?: MemoryScope;
  /** True when this record came out of cold storage; see {@link MemorySearchRequest.includeArchived}. */
  readonly archived?: boolean;
  /** Repo- or store-relative location, when the provider has one. */
  readonly source?: string;
}

/**
 * Why a memory operation produced nothing.
 *
 * Five values, and the distinction between three of them is the whole point of
 * this union:
 *
 * - `disabled` — the user turned memory off. Not a fault.
 * - `not-configured` — memory is on but names no provider, or names one that is
 *   not registered.
 * - `provider-absent` — the configured provider's prerequisites are missing
 *   (no Python, no server, no store directory).
 * - `provider-unprovisioned` — **the third state**, and the one a two-state
 *   model would have collapsed. ADR-0029 C1: Headroom's memory MCP server
 *   handshakes correctly and advertises both tools while both tool calls fail,
 *   because the ONNX embedder needs an ~86 MB model that `HF_HUB_OFFLINE=1`
 *   forbids it to fetch. "Installed but not working" is not "absent", and a
 *   user told "absent" would go and reinstall the thing that is already there.
 * - `provider-error` — the provider was reachable and failed anyway.
 */
export type MemoryUnavailableReason =
  | 'disabled'
  | 'not-configured'
  | 'provider-absent'
  | 'provider-unprovisioned'
  | 'provider-error';

/** Measured-or-absent, never interpolated. Mirrors `HeadroomMeasurement`. */
export type MemoryResult<T> =
  | { readonly available: true; readonly value: T }
  | {
      readonly available: false;
      readonly reason: MemoryUnavailableReason;
      /** Human-readable detail for logs and settings surfaces. Never parsed. */
      readonly detail?: string;
    };

export function memoryUnavailable<T>(
  reason: MemoryUnavailableReason,
  detail?: string,
): MemoryResult<T> {
  return detail === undefined
    ? { available: false, reason }
    : { available: false, reason, detail };
}

export function memoryAvailable<T>(value: T): MemoryResult<T> {
  return { available: true, value };
}

/**
 * A provider's lifecycle state — **three**, not two.
 *
 * See {@link MemoryUnavailableReason} for why `unprovisioned` is separate from
 * `absent`. `builtin-markdown` structurally cannot occupy `unprovisioned`,
 * which is the point of it being the default.
 */
export type MemoryProviderState = 'ready' | 'unprovisioned' | 'absent' | 'disabled';

/** How a provider finds things. */
export type MemorySearchKind = 'lexical' | 'semantic' | 'hybrid' | 'none';

/**
 * What leaves the machine over a provider's lifetime.
 *
 * `first-run-model-fetch` is not a euphemism for "network": it names the exact,
 * disclosed, one-time exception Headroom's embedder requires. `builtin-markdown`
 * is `none`, asserted by test rather than by review.
 */
export type MemoryEgress = 'none' | 'first-run-model-fetch' | 'network';

/**
 * A provider's self-declared shape.
 *
 * Every field is a claim the host is entitled to act on, so every field needs a
 * test against the real provider. The host degrades per-provider off this
 * object instead of hardcoding one engine's limits at the call site.
 */
export interface MemoryProviderCapabilities {
  readonly providerId: string;
  readonly state: MemoryProviderState;
  /** Human-readable one-liner for settings surfaces. */
  readonly summary: string;
  readonly search: MemorySearchKind;
  /** Layers actually honoured on disk — not layers the vendor advertises. */
  readonly scopeLayers: readonly MemoryScopeLayer[];
  /** False when reads are prose the host parses best-effort (ADR-0029 C3). */
  readonly structuredReads: boolean;
  /** Can a memory replace an earlier one, with lineage kept? */
  readonly supersession: boolean;
  /** Does anything age out, and into an archive rather than a delete? */
  readonly decay: boolean;
  readonly archive: boolean;
  /** Is every read recorded where a human can audit it? */
  readonly retrievalLog: boolean;
  /** Does turning this provider on require a setup step beyond a toggle? */
  readonly requiresProvisioning: boolean;
  readonly egress: MemoryEgress;
  /**
   * Limitations stated in the provider's own words.
   *
   * This is where an honest cost goes — `builtin-markdown` names "lexical, not
   * semantic: paraphrases a vector index would catch will be missed" here, with
   * `headroom-mcp` named as the alternative. Displayed, never parsed.
   */
  readonly notes: readonly string[];
}

/**
 * The seam. Three methods, deliberately.
 *
 * `update` / `delete` / history verbs are out (ADR-0029 commitment 2): a verb
 * the host cannot implement against every provider is a verb that becomes a
 * per-provider conditional at every call site.
 *
 * **No method may throw or reject.** A provider that cannot answer returns the
 * unavailable arm of {@link MemoryResult}.
 */
export interface MemoryProvider {
  readonly id: string;
  search(request: MemorySearchRequest): Promise<MemoryResult<readonly MemoryRecord[]>>;
  save(request: MemorySaveRequest): Promise<MemoryResult<readonly string[]>>;
  describe(): Promise<MemoryProviderCapabilities>;
  /** Release any subprocess or handle. Idempotent, non-throwing, optional. */
  dispose?(): Promise<void>;
}
