/**
 * The no-op Headroom adapter (fork: PLAN-040 / SUV-0015).
 *
 * This is the implementation that makes "Headroom is absent" an ordinary,
 * fully-functional state of Vorno rather than a failure. It is what the factory
 * hands back when Headroom is disabled or the SDK cannot be loaded, and it is
 * the reference for the contract's non-throwing guarantee: every method
 * resolves, nothing is fabricated.
 *
 * Behaviour, and the reasoning behind each choice:
 *
 * - **compress returns the caller's messages, unchanged.** Not a copy with the
 *   same fields — the same array. There is no transformation to be byte-exact
 *   about, which is exactly the property a caller needs in order to use this
 *   adapter without branching on `kind`.
 * - **compress issues no retrieval handles.** Nothing was extracted, so there is
 *   nothing to redeem later. `retrievalHandles` is empty rather than carrying a
 *   synthetic handle.
 * - **retrieve reports a miss.** A no-op holds no store, so it cannot return
 *   content for any handle. Inventing content here — echoing the handle, or
 *   returning an empty string — would be the fabrication the plan forbids, in
 *   its most damaging form: silently wrong context handed to a model. It
 *   therefore reports `retrieved: false` with the reason the adapter exists.
 * - **stats are absent, never zero.** `{ available: false, reason }` carries no
 *   numeric fields, so no caller can read a zero that nobody measured.
 *
 * The `reason` is fixed at construction and is the same on every path, so a
 * caller inspecting any single result learns why Headroom is not participating.
 */

import { headroomUnavailable } from '@craft-agent/core/types';
import type {
  HeadroomAdapter,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomRetrieveResult,
  HeadroomUnavailableReason,
  HeadroomMeasurement,
  HeadroomUsageStats,
} from '@craft-agent/core/types';

/** Shared empty handle list — the no-op never issues one. */
const NO_HANDLES: readonly string[] = Object.freeze([]);

/**
 * Build a no-op adapter.
 *
 * @param reason Why Headroom is not participating. Reported verbatim on every
 *   operation, so the state is visible wherever a result is inspected.
 */
export function createNoopHeadroomAdapter(
  reason: HeadroomUnavailableReason = 'disabled',
): HeadroomAdapter {
  return {
    kind: 'noop',

    async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
      return {
        // The identical reference the caller passed in: no copy, no reorder,
        // no coercion. "Unchanged" in the strongest available sense.
        messages: request.messages,
        compressed: false,
        retrievalHandles: NO_HANDLES,
        stats: headroomUnavailable(reason),
      };
    },

    async retrieve(_handle: string): Promise<HeadroomRetrieveResult> {
      return { retrieved: false, reason };
    },

    async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
      return headroomUnavailable(reason);
    },
  };
}
