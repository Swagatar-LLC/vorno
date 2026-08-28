/**
 * Compression, made legible in the session view (fork: PLAN-040 / SUV-0026).
 *
 * SUV-0023 taught the session loop to compress tool outputs and to keep a
 * handle that redeems the byte-identical original. Until now that handle went
 * nowhere: the user saw shorter tool output with no statement that anything had
 * happened and no way to get the original back. Reversibility existed as an
 * internal cache. This module is what turns it into an affordance.
 *
 * Everything decidable lives here rather than in the component, because the
 * three things worth being sure of are all decisions, not pixels:
 *
 * 1. **When to show anything at all.** {@link headroomIndicatorFor} is the only
 *    reader of the marker, and it refuses a partial one. A handle with no sizes
 *    is not showable — the alternative would be an indicator that says
 *    "compressed" and then estimates the numbers, which is precisely the
 *    fabrication PLAN-040 forbids. An activity with no marker yields `null`,
 *    which is how a Headroom-disabled session renders exactly as it did before:
 *    not by hiding a dormant element, but by there being no element.
 *
 * 2. **What a retrieval produced.** {@link resolveHeadroomOriginal} maps the
 *    boundary's result onto a UI state whose success arm is the *only* place a
 *    string can appear. There is deliberately no fallback path from a failed
 *    retrieval to `activity.content`: showing compressed text under the label
 *    "original" is the one outcome this SUV exists to prevent, and the type
 *    makes it unexpressible rather than merely unwritten.
 *
 * 3. **How a size reads.** {@link formatByteSize} states bytes — the unit that
 *    was actually measured. Tokens are what the service charges in, but the
 *    boundary reports them only when it has them, and a token figure the user
 *    cannot check against anything is worse than a byte figure they can.
 */

import type { HeadroomRetrieveResult, HeadroomRetrieveMiss } from '@craft-agent/core/types'

/** The marker as it arrives on an activity. Structural, so a Message works too. */
export interface HeadroomMarkerCarrier {
  headroomHandle?: string
  headroomOriginalBytes?: number
  headroomCompressedBytes?: number
}

/** A complete, showable compression marker. */
export interface HeadroomIndicator {
  /** Redeems the byte-identical original through `HeadroomAdapter.retrieve()`. */
  handle: string
  /** Measured UTF-8 size of the pre-compression text. */
  originalBytes: number
  /** Measured UTF-8 size of the text that entered model context. */
  compressedBytes: number
  /**
   * `originalBytes - compressedBytes`, floored at zero.
   *
   * Floored because compression that *grew* the payload is a real (if odd)
   * outcome, and "saved -412 bytes" is a worse thing to put on screen than
   * "saved 0". The two absolute sizes are shown alongside it either way, so
   * nothing is hidden by the floor.
   */
  savedBytes: number
}

/**
 * Read an activity's compression marker, if it has a complete one.
 *
 * @returns The indicator to render, or `null` when there is nothing truthful to
 *   show — which is every uncompressed item and every item in a workspace with
 *   Headroom switched off.
 */
export function headroomIndicatorFor(
  carrier: HeadroomMarkerCarrier | null | undefined,
): HeadroomIndicator | null {
  if (!carrier) return null

  const { headroomHandle: handle, headroomOriginalBytes: originalBytes, headroomCompressedBytes: compressedBytes } = carrier
  if (typeof handle !== 'string' || handle.length === 0) return null
  if (!isNonNegativeInteger(originalBytes)) return null
  if (!isNonNegativeInteger(compressedBytes)) return null

  return {
    handle,
    originalBytes,
    compressedBytes,
    savedBytes: Math.max(0, originalBytes - compressedBytes),
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * What the "view original" action produced.
 *
 * A discriminated union with exactly one arm carrying content. A caller cannot
 * reach for text on the failure arm, so the compressed body can never be
 * rendered as though it were the original by accident.
 */
export type HeadroomOriginalState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'retrieved'; content: string }
  | { status: 'error'; reason: HeadroomOriginalErrorReason }

/**
 * Why "view original" could not produce the original.
 *
 * `unsupported` is the platform arm: the web viewer renders a shared session
 * with no Headroom service behind it, so there is no retrieval to attempt. The
 * rest are the boundary's own miss reasons, passed through unchanged so the
 * message the user reads corresponds to a real operational state.
 */
export type HeadroomOriginalErrorReason = HeadroomRetrieveMiss | 'unsupported' | 'failed'

/**
 * Drive one "view original" action.
 *
 * @param handle The indicator's handle.
 * @param retrieve The platform's retrieval action, or `undefined` on a platform
 *   that has none (the web viewer). Absent is answered with `unsupported`, not
 *   with a thrown error and not with the compressed text.
 * @returns Always a terminal state. Never throws: a retrieval that rejects is
 *   reported as `failed`, because an exception escaping here would surface as a
 *   blank panel — indistinguishable, to the user, from an empty original.
 */
export async function resolveHeadroomOriginal(
  handle: string,
  retrieve: ((handle: string) => Promise<HeadroomRetrieveResult>) | undefined,
): Promise<HeadroomOriginalState> {
  if (retrieve === undefined) return { status: 'error', reason: 'unsupported' }

  let result: HeadroomRetrieveResult
  try {
    result = await retrieve(handle)
  } catch {
    return { status: 'error', reason: 'failed' }
  }

  // Defensive: the boundary's contract guarantees this shape, but this is the
  // one place where trusting a malformed answer would print something wrong
  // under the word "original".
  if (!result || typeof result !== 'object') return { status: 'error', reason: 'failed' }
  if (result.retrieved !== true) {
    return { status: 'error', reason: isRetrieveMiss(result.reason) ? result.reason : 'failed' }
  }
  if (typeof result.content !== 'string') return { status: 'error', reason: 'failed' }

  return { status: 'retrieved', content: result.content }
}

const RETRIEVE_MISSES: readonly HeadroomRetrieveMiss[] = [
  'disabled',
  'sdk-unavailable',
  'service-unavailable',
  'unknown-handle',
]

function isRetrieveMiss(value: unknown): value is HeadroomRetrieveMiss {
  return typeof value === 'string' && (RETRIEVE_MISSES as readonly string[]).includes(value)
}

/** i18n key for an error reason. Keys live under `turnCard.headroom.error.*`. */
export function headroomErrorMessageKey(reason: HeadroomOriginalErrorReason): string {
  return `turnCard.headroom.error.${reason}`
}

const KIB = 1024

/**
 * A byte count, as it should read in a badge.
 *
 * Exact below 1 KiB, one decimal above it. Rounding is presentation only — the
 * underlying numbers are measured and are shown at full precision in the
 * tooltip built from {@link HeadroomIndicator}.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < KIB) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB']
  let value = bytes / KIB
  let unitIndex = 0
  while (value >= KIB && unitIndex < units.length - 1) {
    value /= KIB
    unitIndex += 1
  }
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1)
  return `${rounded} ${units[unitIndex]}`
}
