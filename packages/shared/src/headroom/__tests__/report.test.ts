/**
 * The Headroom stats report builder (fork: PLAN-040 / SUV-0027).
 *
 * The builder makes three decisions and these tests pin all three: whether the
 * workspace has exposed its statistics at all, which adapter answers for which
 * scope, and what a session with no live adapter looks like. Everything else it
 * does is delegation — the numbers come from `scoped-adapter.ts`, covered next
 * door.
 */

import { describe, expect, it } from 'bun:test';
import { HEADROOM_CONFIG_DEFAULTS, headroomMeasured } from '@craft-agent/core/types';
import type {
  HeadroomAdapter,
  HeadroomConfig,
  HeadroomUsageStats,
} from '@craft-agent/core/types';
import { createNoopHeadroomAdapter } from '../noop-adapter.ts';
import { buildHeadroomStatsReport } from '../report.ts';

const EXPOSED: HeadroomConfig = {
  ...HEADROOM_CONFIG_DEFAULTS,
  enabled: true,
  exposeStats: true,
  compressionEngines: [],
};

function memberReporting(value: HeadroomUsageStats): HeadroomAdapter {
  return {
    ...createNoopHeadroomAdapter('disabled'),
    async stats() {
      return headroomMeasured(value);
    },
  };
}

const SESSION_STATS: HeadroomUsageStats = {
  totalRequests: 4,
  totalTokensBefore: 2000,
  totalTokensAfter: 800,
  totalTokensSaved: 1200,
  retrievals: 2,
};

describe('buildHeadroomStatsReport', () => {
  it('withholds every scope when the workspace has not exposed statistics', async () => {
    const report = await buildHeadroomStatsReport({
      workspaceId: 'ws-1',
      sessionId: 's-1',
      config: { ...EXPOSED, exposeStats: false },
      sessionAdapters: new Map([['s-1', memberReporting(SESSION_STATS)]]),
    });

    expect(report.workspace.stats.available).toBe(false);
    expect(report.session?.stats.available).toBe(false);
    // The numbers must not be on the wire at all — a UI-side check would leave
    // them there for anything that inspected the payload.
    expect(JSON.stringify(report)).not.toContain('1200');
  });

  it('answers the session slice from that session’s own adapter', async () => {
    const report = await buildHeadroomStatsReport({
      workspaceId: 'ws-1',
      sessionId: 's-1',
      config: EXPOSED,
      sessionAdapters: new Map([
        ['s-1', memberReporting(SESSION_STATS)],
        [
          's-2',
          memberReporting({
            totalRequests: 1,
            totalTokensBefore: 100,
            totalTokensAfter: 40,
            totalTokensSaved: 60,
          }),
        ],
      ]),
    });

    expect(report.session?.kind).toBe('session');
    expect(report.session?.id).toBe('s-1');
    const session = report.session?.stats;
    if (!session?.available) throw new Error('expected a session measurement');
    expect(session.value).toEqual(SESSION_STATS);
  });

  it('aggregates the workspace scope over every live session', async () => {
    const report = await buildHeadroomStatsReport({
      workspaceId: 'ws-1',
      config: EXPOSED,
      sessionAdapters: new Map([
        ['s-1', memberReporting(SESSION_STATS)],
        [
          's-2',
          memberReporting({
            totalRequests: 1,
            totalTokensBefore: 100,
            totalTokensAfter: 40,
            totalTokensSaved: 60,
          }),
        ],
      ]),
    });

    expect(report.session).toBeUndefined();
    const workspace = report.workspace.stats;
    if (!workspace.available) throw new Error('expected a workspace measurement');
    expect(workspace.value.totalRequests).toBe(5);
    expect(workspace.value.totalTokensSaved).toBe(1260);
    expect(report.workspace.id).toBe('ws-1');
  });

  it('reports a session with no live adapter as absent, not as zero', async () => {
    const report = await buildHeadroomStatsReport({
      workspaceId: 'ws-1',
      sessionId: 'evicted',
      config: EXPOSED,
      sessionAdapters: new Map(),
    });

    const session = report.session?.stats;
    expect(session?.available).toBe(false);
    if (session?.available) throw new Error('unreachable');
    expect(session?.reason).toBe('sdk-unavailable');
    expect(Object.keys(session ?? {})).toEqual(['available', 'reason']);
  });

  it('reports an empty workspace as absent', async () => {
    const report = await buildHeadroomStatsReport({
      workspaceId: 'ws-1',
      config: EXPOSED,
      sessionAdapters: new Map(),
    });

    expect(report.workspace.stats.available).toBe(false);
  });
});
