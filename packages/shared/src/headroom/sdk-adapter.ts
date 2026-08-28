/**
 * THE Headroom boundary module (fork: PLAN-040 / SUV-0015).
 *
 * This is the only file in the product permitted to touch the `headroom-ai`
 * package. `scripts/check-headroom-boundary.ts` fails CI if any other file
 * under `apps/` or `packages/` imports it. Everything else in Vorno speaks
 * `HeadroomAdapter` (`@craft-agent/core/types`), so an SDK upgrade, a swap to
 * the proxy or MCP surface, or dropping Headroom entirely is a change to this
 * file and nothing else.
 *
 * Four decisions here are load-bearing; each is a defence against something the
 * pinned SDK actually does (SUV-0014's vetting report is the evidence base).
 *
 * 1. **The SDK is loaded dynamically, never statically.** `import type` erases,
 *    and the only value-level reference is inside {@link loadHeadroomSdk}'s
 *    `import()`. Vorno's module graph therefore does not contain `headroom-ai`,
 *    so a build without the package installed still starts — which is what makes
 *    "absent" an ordinary state rather than a crash at import time.
 *
 * 2. **`fallback` is forced off.** The SDK defaults `fallback: true`, and in that
 *    mode an unreachable proxy makes `compress()` resolve with
 *    `{ tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, compressionRatio: 1,
 *    compressed: false }` — fabricated zeros for a request that was never
 *    compressed. Those numbers are exactly what the plan's "measured or absent,
 *    never interpolated" rule forbids reaching a token surface. With `fallback`
 *    off the SDK throws instead, and this module converts the throw into an
 *    honest pass-through with absent stats. The `compressed !== true` check in
 *    {@link SdkHeadroomAdapter.compress} is a second line of defence in case a
 *    future SDK version reintroduces the silent path.
 *
 * 3. **`baseUrl` is always passed explicitly.** The SDK's constructor falls back
 *    to `process.env.HEADROOM_BASE_URL` and only then to `http://localhost:8787`.
 *    An ambient environment variable that silently redirects where Vorno's whole
 *    context is sent is not a channel this boundary should honour, so the
 *    default is pinned here instead. Repointing it is a config decision that
 *    arrives through {@link HeadroomAdapterOptions} (wired in SUV-0018).
 *
 * 4. **Only compress / retrieve / getStats are ever called.** The SDK's
 *    `client.chat.completions` and `client.messages` helpers read
 *    `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from the environment and forward
 *    them to `baseUrl` (SUV-0014 finding F3). This module never references them,
 *    and a test greps this file to keep it that way.
 *
 * Non-throwing is a contract, not a courtesy: every method catches everything
 * and degrades. A caller must never need a try/catch around context compression.
 */

import { headroomMeasured, headroomUnavailable } from '@craft-agent/core/types';
import type {
  HeadroomAdapter,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomCompressStats,
  HeadroomMeasurement,
  HeadroomMessage,
  HeadroomRetrieveResult,
  HeadroomUsageStats,
} from '@craft-agent/core/types';

// Type-only. Erased at runtime by `verbatimModuleSyntax`, so this import does
// NOT put `headroom-ai` in the module graph — it only makes the conformance
// assertion below a real typecheck-time gate on SDK upgrades.
import type { HeadroomClient as PinnedHeadroomClient } from 'headroom-ai';

/** The SDK's documented default. Pinned here so env cannot silently repoint it. */
export const DEFAULT_HEADROOM_BASE_URL = 'http://localhost:8787';

// ---------------------------------------------------------------------------
// The slice of the SDK this boundary depends on
// ---------------------------------------------------------------------------

/**
 * Exactly the SDK members this module uses — nothing else.
 *
 * Declaring the dependency structurally (rather than importing the SDK's own
 * class type) means test doubles need no SDK, and it makes the surface we rely
 * on reviewable in one screen. The conformance assertion below keeps it honest.
 */
export interface HeadroomSdkClient {
  compress(
    messages: unknown[],
    options?: { model?: string; tokenBudget?: number },
  ): Promise<unknown>;
  retrieve(hash: string, options?: { query?: string }): Promise<unknown>;
  getStats(): Promise<unknown>;
}

export interface HeadroomSdkClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  fallback?: boolean;
}

/** The shape {@link loadHeadroomSdk} resolves to. */
export interface HeadroomSdkModule {
  HeadroomClient: new (options?: HeadroomSdkClientOptions) => HeadroomSdkClient;
}

/**
 * Typecheck-time canary on SDK upgrades.
 *
 * If a future `headroom-ai` renames `compress`/`retrieve`/`getStats` or changes
 * their arity, `bun run typecheck` fails *here* — inside the boundary — instead
 * of at runtime in a user's session. This is the concrete form of "the seam
 * contains future SDK upgrades".
 */
type PinnedClientSatisfiesBoundary = PinnedHeadroomClient extends HeadroomSdkClient
  ? true
  : never;
const _pinnedClientConforms: PinnedClientSatisfiesBoundary = true;
void _pinnedClientConforms;

/**
 * Load the pinned SDK.
 *
 * The single value-level reference to `headroom-ai` in the product. Rejects
 * (rather than returning null) when the package is missing; the factory is what
 * turns that into the no-op adapter.
 */
export async function loadHeadroomSdk(): Promise<HeadroomSdkModule> {
  const mod = await import('headroom-ai');
  return mod as unknown as HeadroomSdkModule;
}

// ---------------------------------------------------------------------------
// Wire conversion
// ---------------------------------------------------------------------------

/** Vorno message → the OpenAI-shaped record the SDK sends to the service. */
function toSdkMessage(message: HeadroomMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      ...(message.name === undefined ? {} : { name: message.name }),
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
  };
}

/**
 * Service response record → Vorno message, or `null` when it is not
 * representable at this boundary.
 *
 * `null` is deliberate and is not a hidden failure: the caller
 * ({@link SdkHeadroomAdapter.compress}) treats an unrepresentable response as a
 * reason to discard the whole response and pass the original through untouched.
 * Coercing a null assistant `content` to `''`, or defaulting a missing
 * `tool_call_id`, would silently hand a model altered context — the worst
 * version of the fabrication the plan forbids.
 */
function fromSdkMessage(value: unknown): HeadroomMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const content = record.content;
  if (typeof content !== 'string') return null;

  const name = typeof record.name === 'string' ? record.name : undefined;

  if (record.role === 'tool') {
    const toolCallId = record.tool_call_id;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null;
    return { role: 'tool', content, toolCallId, ...(name === undefined ? {} : { name }) };
  }

  if (record.role === 'system' || record.role === 'user' || record.role === 'assistant') {
    return { role: record.role, content, ...(name === undefined ? {} : { name }) };
  }

  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read per-call stats out of a compress response.
 *
 * Every numeric field must be genuinely present and finite; one missing number
 * makes the whole measurement absent. Partially-populated stats with implicit
 * zeros are precisely the outcome the plan's rule exists to prevent.
 */
function readCompressStats(record: Record<string, unknown>): HeadroomCompressStats | null {
  const { tokensBefore, tokensAfter, tokensSaved, compressionRatio } = record;
  if (
    !isFiniteNumber(tokensBefore) ||
    !isFiniteNumber(tokensAfter) ||
    !isFiniteNumber(tokensSaved) ||
    !isFiniteNumber(compressionRatio)
  ) {
    return null;
  }
  return {
    tokensBefore,
    tokensAfter,
    tokensSaved,
    compressionRatio,
    transformsApplied: toStringArray(record.transformsApplied),
  };
}

function readUsageStats(value: unknown): HeadroomUsageStats | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const {
    totalRequests,
    totalTokensBefore,
    totalTokensAfter,
    totalTokensSaved,
    averageCompressionRatio,
    cacheHits,
  } = record;
  if (
    !isFiniteNumber(totalRequests) ||
    !isFiniteNumber(totalTokensBefore) ||
    !isFiniteNumber(totalTokensAfter) ||
    !isFiniteNumber(totalTokensSaved) ||
    !isFiniteNumber(averageCompressionRatio) ||
    !isFiniteNumber(cacheHits)
  ) {
    return null;
  }
  return {
    totalRequests,
    totalTokensBefore,
    totalTokensAfter,
    totalTokensSaved,
    averageCompressionRatio,
    cacheHits,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Pass the caller's messages through untouched, with stats explicitly absent. */
function passThrough(request: HeadroomCompressRequest): HeadroomCompressResult {
  return {
    messages: request.messages,
    compressed: false,
    retrievalHandles: [],
    stats: headroomUnavailable('service-unavailable'),
  };
}

export class SdkHeadroomAdapter implements HeadroomAdapter {
  readonly kind = 'sdk' as const;

  constructor(
    private readonly client: HeadroomSdkClient,
    private readonly defaultModel?: string,
  ) {}

  async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
    const model = request.model ?? this.defaultModel;
    let raw: unknown;
    try {
      raw = await this.client.compress(request.messages.map(toSdkMessage), {
        ...(model === undefined ? {} : { model }),
        ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }),
      });
    } catch {
      // Unreachable service, timeout, error status. Ordinary, not exceptional.
      return passThrough(request);
    }

    if (typeof raw !== 'object' || raw === null) return passThrough(request);
    const record = raw as Record<string, unknown>;

    // Guards the SDK's own silent-fallback shape (`compressed: false` with zeroed
    // token counts) even though `fallback: false` should prevent it.
    if (record.compressed !== true) return passThrough(request);

    if (!Array.isArray(record.messages)) return passThrough(request);
    const messages: HeadroomMessage[] = [];
    for (const entry of record.messages) {
      const message = fromSdkMessage(entry);
      if (message === null) return passThrough(request);
      messages.push(message);
    }

    const stats = readCompressStats(record);

    return {
      messages,
      compressed: true,
      retrievalHandles: toStringArray(record.ccrHashes),
      // Compression is real even if the service declined to report numbers, so
      // this reports absent stats rather than discarding the compressed result.
      stats:
        stats === null ? headroomUnavailable('service-unavailable') : headroomMeasured(stats),
    };
  }

  async retrieve(handle: string): Promise<HeadroomRetrieveResult> {
    let raw: unknown;
    try {
      raw = await this.client.retrieve(handle);
    } catch (error) {
      // The proxy signals "I do not hold that hash" as HTTP 404, which the SDK
      // maps to a thrown error carrying `statusCode`. Collapsing that into
      // `service-unavailable` would tell a caller the service is down when it
      // answered perfectly well, so the two are kept apart here. Read
      // structurally rather than via `instanceof` — the boundary must not depend
      // on the SDK's error class identity surviving an upgrade or a bundler.
      const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
      if (statusCode === 404) return { retrieved: false, reason: 'unknown-handle' };
      return { retrieved: false, reason: 'service-unavailable' };
    }

    if (typeof raw !== 'object' || raw === null) {
      return { retrieved: false, reason: 'service-unavailable' };
    }

    const content = (raw as Record<string, unknown>).originalContent;
    // The service answered but holds nothing under this handle. Distinct from
    // being unable to ask, and reported as such.
    if (typeof content !== 'string') return { retrieved: false, reason: 'unknown-handle' };

    return { retrieved: true, content };
  }

  async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
    let raw: unknown;
    try {
      raw = await this.client.getStats();
    } catch {
      return headroomUnavailable('service-unavailable');
    }
    const usage = readUsageStats(raw);
    return usage === null ? headroomUnavailable('service-unavailable') : headroomMeasured(usage);
  }
}

/**
 * Construct the SDK client this boundary wraps.
 *
 * Separated from {@link SdkHeadroomAdapter} so the client-construction policy
 * (points 2 and 3 in the module docstring) is one reviewable function.
 */
export function createSdkClient(
  sdk: HeadroomSdkModule,
  options: { baseUrl?: string; apiKey?: string; timeoutMs?: number },
): HeadroomSdkClient {
  return new sdk.HeadroomClient({
    baseUrl: options.baseUrl ?? DEFAULT_HEADROOM_BASE_URL,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    // See point 2: never let the SDK answer with fabricated zeros.
    fallback: false,
  });
}
