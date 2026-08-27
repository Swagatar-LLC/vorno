/**
 * Tool output → compressed context item (fork: PLAN-040 / SUV-0023).
 *
 * SUV-0015 built the boundary, SUV-0018 gave every session an adapter, and
 * nothing called it. This is the first real call: the one function that turns a
 * single tool result into the text that enters session context, plus the handle
 * that redeems the original.
 *
 * It speaks only {@link HeadroomAdapter} — no `headroom-ai` import, which is
 * what keeps `scripts/check-headroom-boundary.ts` finding exactly one importer.
 *
 * Four rules decide whether a compressed response is *accepted*. All four exist
 * because the failure they prevent is the same one: handing a model context that
 * is smaller than the truth and no longer recoverable. Pass-through is always
 * safe, so every rule fails towards it.
 *
 * 1. **`compressed !== true` is a pass-through.** The adapter already reports an
 *    honest non-compression when the service declines, times out, or answers
 *    with a shape it refuses to trust. Nothing to do.
 * 2. **Exactly one message back, and it must answer the same call.** A request
 *    carrying one tool message has one representable answer. A response with a
 *    different count, a different role, or a different `toolCallId` is about
 *    something other than what was asked, and is discarded whole rather than
 *    reconciled.
 * 3. **Exactly one retrieval handle.** This is the strict rule and it is
 *    deliberate. The carrier is a single handle on a single context item, so it
 *    can only make the round-trip promise for a response that issued a single
 *    handle covering the whole original. A response that extracted several
 *    chunks would need the caller to hold a list to get the original back, and
 *    accepting it here would mean shipping compressed content whose
 *    `retrieve()` returns a *fragment* — silently wrong context, arriving as
 *    though it were the original. Widening the carrier to a handle list is a
 *    real follow-up; quietly taking `handles[0]` is not.
 * 4. **Empty content is never sent.** There is no compression to win on it, and
 *    an empty tool result is exactly where a service is most likely to answer
 *    with something unrepresentable.
 *
 * Non-throwing, like everything else on this seam: a compression bug must not be
 * able to fail a turn, so the whole body degrades to pass-through.
 */

import type {
  HeadroomAdapter,
  HeadroomCompressStats,
  HeadroomMeasurement,
} from '@craft-agent/core/types';
import { headroomUnavailable } from '@craft-agent/core/types';

/** One tool result, as this module needs to see it. */
export interface ToolOutputCompressionInput {
  /** Id of the tool call this output answers. Required — never synthesized. */
  readonly toolCallId: string;
  /** Tool name, when the caller knows it. */
  readonly toolName?: string;
  /** The text that would otherwise enter session context verbatim. */
  readonly content: string;
}

export interface ToolOutputCompression {
  /**
   * The text to put into session context. Identical to the input content — the
   * same string reference — whenever {@link handle} is absent.
   */
  readonly content: string;
  /**
   * The retrieval handle for the original content, present if and only if the
   * compression was accepted. `adapter.retrieve(handle)` redeems it.
   */
  readonly handle?: string;
  readonly stats: HeadroomMeasurement<HeadroomCompressStats>;
}

/** The unchanged answer. Carries the caller's own string, not a copy of it. */
function passThrough(
  input: ToolOutputCompressionInput,
  stats: HeadroomMeasurement<HeadroomCompressStats>,
): ToolOutputCompression {
  return { content: input.content, stats };
}

/**
 * Route one tool output through the session's Headroom adapter.
 *
 * Always calls {@link HeadroomAdapter.compress} — including on the no-op
 * adapter, which answers with the caller's own messages and no handles. Not
 * branching on `adapter.kind` is the point of the boundary: "Headroom is off"
 * is expressed by which adapter the session holds, never by a call site
 * deciding for itself.
 *
 * @returns The content to place in context, and a handle when — and only when —
 *   that content is genuinely compressed and the original is redeemable.
 */
export async function compressToolOutput(
  adapter: HeadroomAdapter,
  input: ToolOutputCompressionInput,
): Promise<ToolOutputCompression> {
  // Rule 4.
  if (input.content.length === 0) {
    return passThrough(input, headroomUnavailable('service-unavailable'));
  }

  let result;
  try {
    result = await adapter.compress({
      messages: [
        {
          role: 'tool',
          content: input.content,
          toolCallId: input.toolCallId,
          ...(input.toolName === undefined ? {} : { name: input.toolName }),
        },
      ],
    });
  } catch {
    // The contract says this cannot happen. Defence in depth anyway: a session
    // turn must not be able to fail because context compression misbehaved.
    return passThrough(input, headroomUnavailable('service-unavailable'));
  }

  // Rule 1.
  if (!result.compressed) return passThrough(input, result.stats);

  // Rule 2.
  if (result.messages.length !== 1) return passThrough(input, result.stats);
  const message = result.messages[0];
  if (message === undefined) return passThrough(input, result.stats);
  if (message.role !== 'tool') return passThrough(input, result.stats);
  if (message.toolCallId !== input.toolCallId) return passThrough(input, result.stats);

  // Rule 3.
  if (result.retrievalHandles.length !== 1) return passThrough(input, result.stats);
  const handle = result.retrievalHandles[0];
  if (handle === undefined || handle.length === 0) return passThrough(input, result.stats);

  return { content: message.content, handle, stats: result.stats };
}
