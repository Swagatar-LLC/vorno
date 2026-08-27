/**
 * Headroom adapter contract (fork: PLAN-040 / SUV-0015).
 *
 * This is the Vorno-owned shape of "context compression". Everything in the app
 * that ever talks to Headroom talks to {@link HeadroomAdapter} — never to the
 * `headroom-ai` package. The single implementation that imports the SDK lives at
 * `packages/shared/src/headroom/sdk-adapter.ts`, and a CI gate
 * (`scripts/check-headroom-boundary.ts`) fails the build if any other file
 * imports it. That seam is the point of this SUV: an SDK upgrade, a swap to the
 * MCP or proxy surface, or dropping Headroom entirely is a change to one file.
 *
 * Deliberate constraints, and why:
 *
 * - **Import-free, plain data.** Same rule as `headroom.ts` (SUV-0016): no SDK
 *   types leak through this file, so `@craft-agent/core` never gains a runtime
 *   dependency on Headroom and a future server-homed instance can carry the
 *   identical shape over the wire.
 * - **Measured or absent, never interpolated.** The plan forbids fabricated
 *   numbers. Statistics are therefore wrapped in {@link HeadroomMeasurement},
 *   whose absent arm carries a reason and *no* numeric fields — a caller cannot
 *   read a zero that nobody measured. This is not hypothetical: the pinned SDK's
 *   own offline fallback returns `tokensBefore: 0, tokensSaved: 0` for a request
 *   that was never compressed, and the boundary is what stops those zeros from
 *   reaching a token surface.
 * - **Non-throwing by contract.** Headroom being absent, disabled, or
 *   unreachable is an ordinary state, not an error: every operation resolves,
 *   degrading to pass-through rather than rejecting. Callers get correct
 *   behaviour without a try/catch at every call site.
 * - **compress / retrieve / stats only.** The SDK also exposes chat and messages
 *   helpers that read `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from the
 *   environment and forward them to `baseUrl` (SUV-0014 finding F3). Those are
 *   deliberately *not* on this interface, and a test asserts the boundary module
 *   never touches them.
 *
 * Nothing consumes this yet. Resolved configuration drives the factory in
 * SUV-0018; call sites in the session loop and Conductor are I1.
 */

/** Roles the boundary can represent. Wider provider shapes are converted at the seam. */
export type HeadroomMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export const HEADROOM_MESSAGE_ROLES: readonly HeadroomMessageRole[] = [
  'system',
  'user',
  'assistant',
  'tool',
];

/**
 * One message as the boundary sees it.
 *
 * Text-only on purpose. Compression targets bulky textual context (tool output
 * above all); a shape that also claimed to carry images or provider-specific
 * blocks would be a promise this SUV cannot verify against the pinned SDK.
 *
 * A union rather than one interface with an optional `toolCallId`, because a
 * tool result is not expressible in the wire format without the id of the call
 * it answers. Making it required here means the boundary never has to invent
 * one — the alternative to a real id is a caller-side compile error, not a
 * fabricated empty string sent to a service.
 */
export type HeadroomMessage =
  | {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
      /** Speaker name, when the caller has one. */
      readonly name?: string;
    }
  | {
      readonly role: 'tool';
      readonly content: string;
      /** Id of the tool call this message answers. Required — never synthesized. */
      readonly toolCallId: string;
      /** Tool name, when known. */
      readonly name?: string;
    };

/**
 * Why a Headroom result is unavailable. Every value is a real, distinguishable
 * operational state — none of them means "zero".
 *
 * - `disabled` — Headroom is switched off for this workspace/instance. Expected.
 * - `sdk-unavailable` — the `headroom-ai` package could not be loaded (not
 *   installed, or its module graph failed). Expected in a build that ships
 *   without it.
 * - `service-unavailable` — the SDK loaded but the compression service did not
 *   answer usefully (unreachable proxy, timeout, error status, or a response the
 *   boundary refuses to trust).
 */
export type HeadroomUnavailableReason =
  | 'disabled'
  | 'sdk-unavailable'
  | 'service-unavailable';

/**
 * A value that was genuinely measured, or an explicit statement that it was not.
 *
 * The absent arm carries no numbers at all — that is the type-level form of the
 * plan's "measured or absent, never interpolated" rule, and it survives
 * `JSON.stringify` intact so a UI reading it over the wire cannot mistake a
 * missing measurement for a real zero.
 */
export type HeadroomMeasurement<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: HeadroomUnavailableReason };

/** Build the absent arm of a {@link HeadroomMeasurement}. */
export function headroomUnavailable<T>(
  reason: HeadroomUnavailableReason,
): HeadroomMeasurement<T> {
  return { available: false, reason };
}

/** Build the present arm of a {@link HeadroomMeasurement}. */
export function headroomMeasured<T>(value: T): HeadroomMeasurement<T> {
  return { available: true, value };
}

/** Per-call compression measurement. Only ever produced from a real response. */
export interface HeadroomCompressStats {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensSaved: number;
  /** `tokensAfter / tokensBefore` as reported by the service. */
  readonly compressionRatio: number;
  readonly transformsApplied: readonly string[];
}

/** Cumulative usage measurement for the connected Headroom service. */
export interface HeadroomUsageStats {
  readonly totalRequests: number;
  readonly totalTokensBefore: number;
  readonly totalTokensAfter: number;
  readonly totalTokensSaved: number;
  readonly averageCompressionRatio: number;
  readonly cacheHits: number;
}

export interface HeadroomCompressRequest {
  readonly messages: readonly HeadroomMessage[];
  /** Model whose tokenizer/budget the service should assume. */
  readonly model?: string;
  /** Compress to fit within this many tokens, when the caller has a budget. */
  readonly tokenBudget?: number;
}

export interface HeadroomCompressResult {
  /**
   * The messages to send onward. When {@link compressed} is false these are the
   * request's messages, unchanged — a caller can always use this field.
   */
  readonly messages: readonly HeadroomMessage[];
  /** True only when the service actually returned compressed content. */
  readonly compressed: boolean;
  /**
   * Opaque handles for content the service extracted, redeemable via
   * {@link HeadroomAdapter.retrieve}. Empty when nothing was extracted.
   */
  readonly retrievalHandles: readonly string[];
  readonly stats: HeadroomMeasurement<HeadroomCompressStats>;
}

/**
 * Why a retrieval produced nothing. `unknown-handle` means the service was
 * reachable and simply does not hold that handle — distinct from being unable
 * to ask at all.
 */
export type HeadroomRetrieveMiss = HeadroomUnavailableReason | 'unknown-handle';

export type HeadroomRetrieveResult =
  | { readonly retrieved: true; readonly content: string }
  | { readonly retrieved: false; readonly reason: HeadroomRetrieveMiss };

/** Which implementation answered. Diagnostics and tests only — not a feature flag. */
export type HeadroomAdapterKind = 'noop' | 'sdk';

/**
 * The whole of Vorno's Headroom surface.
 *
 * Implementations MUST NOT throw from any method: an unavailable Headroom is a
 * normal state and is reported in the return value.
 */
export interface HeadroomAdapter {
  readonly kind: HeadroomAdapterKind;

  /**
   * Compress a message list. On any failure, returns the input messages
   * unchanged with `compressed: false` and absent stats.
   */
  compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult>;

  /** Redeem a handle from a previous {@link compress} for its original content. */
  retrieve(handle: string): Promise<HeadroomRetrieveResult>;

  /** Cumulative usage, or an explicit statement that it is unavailable. */
  stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>>;
}

/**
 * What the factory needs to build an adapter.
 *
 * Deliberately *not* `HeadroomConfig`. Config resolution is SUV-0016 and wiring
 * resolved config into this factory is SUV-0018; the boundary reads no settings
 * of its own, so it stays testable and has exactly one caller-supplied truth
 * about whether Headroom is on.
 */
export interface HeadroomAdapterOptions {
  /** Already resolved by the caller. False yields the no-op adapter. */
  readonly enabled: boolean;
  /** Headroom service base URL. Defaults to the SDK's documented local proxy. */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Default model for compress calls that do not name one. */
  readonly model?: string;
}
