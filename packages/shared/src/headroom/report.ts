/**
 * Build the Headroom savings report (fork: PLAN-040 / SUV-0027).
 *
 * One function, called by whoever holds the live sessions — in the desktop app
 * that is `SessionManager`, and a server-homed instance (PLAN-041) would call
 * the identical function with the identical inputs. It does no arithmetic: it
 * decides *which* adapters answer for which scope and then asks each of them for
 * its `stats()`. The numbers are produced inside the adapters
 * (`scoped-adapter.ts`), which is what keeps SUV-0027's "no computation of
 * savings outside the adapter" true all the way up to React.
 *
 * **`exposeStats` is honoured here, and only here.** SUV-0016 shipped that
 * config field with the documented meaning "make Headroom's context and token
 * statistics available to the rest of the app", and until now nothing read it.
 * This is the surface it was written for, so a workspace that has not switched
 * it on gets the absent arm rather than numbers. The gate is applied once, in
 * the builder, rather than in the view — a UI-side check would leave the numbers
 * on the wire, which is exactly what a workspace that turned the field off asked
 * not to happen.
 */

import type {
  HeadroomAdapter,
  HeadroomConfig,
  HeadroomStatsReport,
  HeadroomStatsScope,
} from '@craft-agent/core/types';
import { headroomUnavailable } from '@craft-agent/core/types';
import { createAggregateHeadroomAdapter } from './scoped-adapter.ts';

export interface HeadroomReportInput {
  readonly workspaceId: string;
  /** Ask for a session slice. Omit for the workspace aggregate alone. */
  readonly sessionId?: string;
  /** The workspace's resolved effective config. Read for `exposeStats` only. */
  readonly config: HeadroomConfig;
  /**
   * Live sessions in this workspace, keyed by session id, each mapped to the
   * scope-counting adapter that session holds.
   *
   * Only *live* sessions can appear: a session whose agent runtime was evicted
   * (PLAN-038's idle sweep) took its in-memory counters with it. That is a real
   * limitation of an in-process measurement and the report states it by
   * omission — an absent session slice reads as "no measurement", never as zero.
   */
  readonly sessionAdapters: ReadonlyMap<string, HeadroomAdapter>;
}

/**
 * Assemble the report for one workspace, optionally with one session's slice.
 *
 * Never throws: an adapter that misbehaves is contained, because every adapter
 * on this seam is non-throwing by contract and the aggregate is one of them.
 */
export async function buildHeadroomStatsReport(
  input: HeadroomReportInput,
): Promise<HeadroomStatsReport> {
  const { workspaceId, sessionId, config, sessionAdapters } = input;

  if (!config.exposeStats) {
    // Deliberately the same shape as any other absent measurement, so the view
    // needs no special case — it already knows how to render "no stats, and
    // here is the reason".
    const withheld = headroomUnavailable<
      Extract<HeadroomStatsScope['stats'], { available: true }>['value']
    >('disabled');
    return {
      workspace: { kind: 'workspace', id: workspaceId, stats: withheld },
      ...(sessionId === undefined
        ? {}
        : { session: { kind: 'session' as const, id: sessionId, stats: withheld } }),
    };
  }

  const aggregate = createAggregateHeadroomAdapter(() => sessionAdapters.values());

  const workspace: HeadroomStatsScope = {
    kind: 'workspace',
    id: workspaceId,
    stats: await aggregate.stats(),
  };

  if (sessionId === undefined) return { workspace };

  const sessionAdapter = sessionAdapters.get(sessionId);
  if (sessionAdapter === undefined) {
    // The session exists but holds no adapter right now (never started, or its
    // runtime was disposed). `sdk-unavailable` is the honest reason: there is no
    // adapter here to answer, which is not the same as Headroom being off.
    return {
      workspace,
      session: {
        kind: 'session',
        id: sessionId,
        stats: headroomUnavailable('sdk-unavailable'),
      },
    };
  }

  return {
    workspace,
    session: { kind: 'session', id: sessionId, stats: await sessionAdapter.stats() },
  };
}
