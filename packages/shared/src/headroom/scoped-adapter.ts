/**
 * Scope-counting Headroom adapters (fork: PLAN-040 / SUV-0027).
 *
 * SUV-0027 has to show a user what compression saved **in this session** and
 * **across this workspace**. Neither number exists anywhere today:
 * `SdkHeadroomAdapter.stats()` returns the *service's* cumulative counters,
 * which span every session, every workspace and every other client pointed at
 * the same proxy. Rendering those as "this session saved N tokens" would be a
 * real measurement of the wrong thing — the subtlest version of the fabrication
 * the plan forbids.
 *
 * So the scoping lives here, in two more implementations of the one contract:
 *
 * - {@link createScopedHeadroomAdapter} wraps a session's adapter and counts
 *   what passes through *it*.
 * - {@link createAggregateHeadroomAdapter} sums the scopes underneath it.
 *
 * **Why adapters and not helper functions.** SUV-0027's acceptance says every
 * figure the view renders must trace to `adapter.stats()`, with no computation
 * of savings outside the adapter. Making the scoping an adapter is what keeps
 * that literally true: the arithmetic is inside a `HeadroomAdapter`
 * implementation, in the boundary module, and every layer above — RPC, view
 * model, React — only ever moves an opaque measurement around. If this were a
 * `sumHeadroomStats()` utility called by the RPC handler, savings would be
 * computed outside an adapter and the invariant would be gone.
 *
 * **What is deliberately not counted.** `averageCompressionRatio` and
 * `cacheHits` are omitted by both implementations. A mean of per-call ratios is
 * not the ratio of the totals, and a wrapper cannot see the service's cache at
 * all. Both fields are optional on {@link HeadroomUsageStats} precisely so an
 * implementation that cannot measure them can say so by omission; the view
 * renders an omitted field as unknown, never as zero.
 *
 * Non-throwing, like everything on this seam.
 */

import { headroomMeasured, headroomUnavailable } from '@craft-agent/core/types';
import type {
  HeadroomAdapter,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomMeasurement,
  HeadroomRetrieveResult,
  HeadroomUnavailableReason,
  HeadroomUsageStats,
} from '@craft-agent/core/types';

/** Running totals for one scope. Only ever advanced from a real measurement. */
interface ScopeCounters {
  /** Compress results that carried a measurement. The denominator for the rest. */
  requests: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** Successful `retrieve()` round-trips. A miss is not a retrieval. */
  retrievals: number;
}

/**
 * Wrap an adapter so its `stats()` describes *this scope* rather than the
 * service.
 *
 * Delegation is exact: `compress` and `retrieve` return the inner adapter's own
 * result object, untouched. That matters more than it looks — the no-op adapter
 * promises callers the identical `messages` array reference they passed in, and
 * a wrapper that rebuilt the result would quietly break that promise for every
 * session, since every session is wrapped.
 *
 * `kind` is the inner adapter's, because `kind` answers "which implementation
 * is really talking to Headroom" and the answer is unchanged by counting.
 *
 * @param inner The adapter to delegate to.
 * @param emptyReason What to report when the scope has measured nothing yet.
 *   Supplied by the caller because only the caller knows *why* there is nothing:
 *   Headroom switched off, an SDK that would not load, or a live service that
 *   has simply not been asked to compress anything in this session. The absent
 *   arm carries no numbers, so an un-run session renders as unknown rather than
 *   as a row of zeros.
 */
export function createScopedHeadroomAdapter(
  inner: HeadroomAdapter,
  emptyReason: HeadroomUnavailableReason,
): HeadroomAdapter {
  const counters: ScopeCounters = {
    requests: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    retrievals: 0,
  };

  return {
    kind: inner.kind,

    async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
      const result = await inner.compress(request);
      const stats = result.stats;
      if (stats.available) {
        counters.requests += 1;
        counters.tokensBefore += stats.value.tokensBefore;
        counters.tokensAfter += stats.value.tokensAfter;
        counters.tokensSaved += stats.value.tokensSaved;
      }
      return result;
    },

    async retrieve(handle: string): Promise<HeadroomRetrieveResult> {
      const result = await inner.retrieve(handle);
      // Only a redeemed original counts. A miss says the service was asked and
      // had nothing — reporting it as a retrieval would overstate the affordance
      // SUV-0026 is building.
      if (result.retrieved) counters.retrievals += 1;
      return result;
    },

    async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
      // Nothing measured is not zero savings — it is no measurement. The two are
      // indistinguishable on a chart and completely different to a user deciding
      // whether Headroom is worth leaving on.
      if (counters.requests === 0 && counters.retrievals === 0) {
        return headroomUnavailable(emptyReason);
      }

      return headroomMeasured({
        totalRequests: counters.requests,
        totalTokensBefore: counters.tokensBefore,
        totalTokensAfter: counters.tokensAfter,
        totalTokensSaved: counters.tokensSaved,
        retrievals: counters.retrievals,
      });
    },
  };
}

/**
 * The read-side aggregate over a set of scopes.
 *
 * This is a reporting adapter and nothing else: it compresses nothing and holds
 * no store, so `compress` passes through and `retrieve` misses — both with the
 * reason below, both honest. It exists so that a workspace total is produced by
 * an `adapter.stats()` call like every other figure in the report.
 *
 * @param members Re-read on every `stats()` call rather than captured, so a
 *   session that started after the view mounted is included in the next refresh
 *   without anyone rebuilding the aggregate.
 */
export function createAggregateHeadroomAdapter(
  members: () => Iterable<HeadroomAdapter>,
): HeadroomAdapter {
  return {
    // Nothing here talks to the SDK, so `noop` is the truthful answer to "which
    // implementation is this". `kind` is diagnostics, never a feature flag.
    kind: 'noop',

    async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
      return {
        messages: request.messages,
        compressed: false,
        retrievalHandles: [],
        stats: headroomUnavailable('service-unavailable'),
      };
    },

    async retrieve(): Promise<HeadroomRetrieveResult> {
      return { retrieved: false, reason: 'service-unavailable' };
    },

    async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
      const measurements = await Promise.all(
        [...members()].map((member) => member.stats()),
      );

      const present = measurements.filter(
        (measurement): measurement is Extract<typeof measurement, { available: true }> =>
          measurement.available,
      );

      if (present.length === 0) {
        // Every member had nothing to report. Pass the first member's reason
        // through so the view can say *why* — "Headroom is off" and "nothing
        // compressed yet" are different sentences. With no members at all there
        // is no session running, which is the disabled-shaped answer.
        const first = measurements[0];
        return headroomUnavailable(
          first === undefined || first.available ? 'disabled' : first.reason,
        );
      }

      const totals = present.reduce(
        (acc, measurement) => {
          const value = measurement.value;
          return {
            totalRequests: acc.totalRequests + value.totalRequests,
            totalTokensBefore: acc.totalTokensBefore + value.totalTokensBefore,
            totalTokensAfter: acc.totalTokensAfter + value.totalTokensAfter,
            totalTokensSaved: acc.totalTokensSaved + value.totalTokensSaved,
            // Summed only over members that reported one. A member that omitted
            // the field is not counted as zero, and if *no* member reported one
            // the aggregate omits it too (see below).
            retrievals:
              value.retrievals === undefined
                ? acc.retrievals
                : (acc.retrievals ?? 0) + value.retrievals,
          };
        },
        {
          totalRequests: 0,
          totalTokensBefore: 0,
          totalTokensAfter: 0,
          totalTokensSaved: 0,
          retrievals: undefined as number | undefined,
        },
      );

      return headroomMeasured({
        totalRequests: totals.totalRequests,
        totalTokensBefore: totals.totalTokensBefore,
        totalTokensAfter: totals.totalTokensAfter,
        totalTokensSaved: totals.totalTokensSaved,
        ...(totals.retrievals === undefined ? {} : { retrievals: totals.retrievals }),
      });
    },
  };
}
