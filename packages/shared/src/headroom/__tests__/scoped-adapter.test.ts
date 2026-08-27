/**
 * Scope-counting adapters (fork: PLAN-040 / SUV-0027).
 *
 * These cover the two properties the report view depends on and nothing else
 * checks:
 *
 *   1. A scope that measured nothing answers **absent**, carrying the reason it
 *      was constructed with — not a row of zeros. This is the whole
 *      "measured or absent" contract at the place a user would see it.
 *   2. Delegation is exact. Every session in the app is wrapped from now on, so
 *      a wrapper that reshaped a compress result would silently break the no-op
 *      adapter's identical-array promise for the entire product.
 */

import { describe, expect, it } from 'bun:test';
import { headroomMeasured, headroomUnavailable } from '@craft-agent/core/types';
import type {
  HeadroomAdapter,
  HeadroomCompressRequest,
  HeadroomCompressResult,
  HeadroomCompressStats,
  HeadroomMeasurement,
  HeadroomRetrieveResult,
  HeadroomUsageStats,
} from '@craft-agent/core/types';
import { createNoopHeadroomAdapter } from '../noop-adapter.ts';
import {
  createAggregateHeadroomAdapter,
  createScopedHeadroomAdapter,
} from '../scoped-adapter.ts';

function compressStats(over: Partial<HeadroomCompressStats> = {}): HeadroomCompressStats {
  return {
    tokensBefore: 1000,
    tokensAfter: 400,
    tokensSaved: 600,
    compressionRatio: 0.4,
    transformsApplied: ['summarize'],
    ...over,
  };
}

/** A stub that answers `compress` with the queued measurements, in order. */
function stubAdapter(
  queue: HeadroomMeasurement<HeadroomCompressStats>[],
  retrieveResult: HeadroomRetrieveResult = { retrieved: true, content: 'original' },
): HeadroomAdapter {
  let index = 0;
  return {
    kind: 'sdk',
    async compress(request: HeadroomCompressRequest): Promise<HeadroomCompressResult> {
      const stats = queue[index++] ?? headroomUnavailable<HeadroomCompressStats>(
        'service-unavailable',
      );
      return {
        messages: request.messages,
        compressed: stats.available,
        retrievalHandles: [],
        stats,
      };
    },
    async retrieve(): Promise<HeadroomRetrieveResult> {
      return retrieveResult;
    },
    async stats(): Promise<HeadroomMeasurement<HeadroomUsageStats>> {
      // The service's cumulative counters — deliberately wild, so a test that
      // saw them leak into a scope would fail loudly.
      return headroomMeasured({
        totalRequests: 99999,
        totalTokensBefore: 99999,
        totalTokensAfter: 99999,
        totalTokensSaved: 99999,
      });
    },
  };
}

describe('createScopedHeadroomAdapter', () => {
  it('reports absent — not zero — before anything is measured', async () => {
    const scoped = createScopedHeadroomAdapter(stubAdapter([]), 'service-unavailable');

    const stats = await scoped.stats();

    expect(stats.available).toBe(false);
    if (stats.available) throw new Error('unreachable');
    expect(stats.reason).toBe('service-unavailable');
    // The absent arm must carry no numbers at all: this is what stops a renderer
    // reading a zero nobody measured.
    expect(Object.keys(stats)).toEqual(['available', 'reason']);
  });

  it('never surfaces the inner adapter’s service-wide counters as the scope', async () => {
    const scoped = createScopedHeadroomAdapter(stubAdapter([]), 'service-unavailable');

    const stats = await scoped.stats();

    // The stub's own stats() reports 99999s. A scope with no measurements must
    // not borrow them.
    expect(JSON.stringify(stats)).not.toContain('99999');
  });

  it('accumulates only measured compress results, and reports the count as the denominator', async () => {
    const scoped = createScopedHeadroomAdapter(
      stubAdapter([
        headroomMeasured(compressStats({ tokensBefore: 1000, tokensAfter: 400, tokensSaved: 600 })),
        headroomUnavailable<HeadroomCompressStats>('service-unavailable'),
        headroomMeasured(compressStats({ tokensBefore: 500, tokensAfter: 100, tokensSaved: 400 })),
      ]),
      'service-unavailable',
    );

    for (let i = 0; i < 3; i++) {
      await scoped.compress({ messages: [{ role: 'user', content: 'x' }] });
    }

    const stats = await scoped.stats();
    if (!stats.available) throw new Error('expected a measurement');
    expect(stats.value.totalRequests).toBe(2);
    expect(stats.value.totalTokensBefore).toBe(1500);
    expect(stats.value.totalTokensAfter).toBe(500);
    expect(stats.value.totalTokensSaved).toBe(1000);
  });

  it('omits what it cannot measure rather than writing a zero', async () => {
    const scoped = createScopedHeadroomAdapter(
      stubAdapter([headroomMeasured(compressStats())]),
      'service-unavailable',
    );
    await scoped.compress({ messages: [{ role: 'user', content: 'x' }] });

    const stats = await scoped.stats();
    if (!stats.available) throw new Error('expected a measurement');
    expect('averageCompressionRatio' in stats.value).toBe(false);
    expect('cacheHits' in stats.value).toBe(false);
  });

  it('counts redeemed retrievals and ignores misses', async () => {
    const hit = createScopedHeadroomAdapter(
      stubAdapter([], { retrieved: true, content: 'original' }),
      'service-unavailable',
    );
    await hit.retrieve('handle-1');
    const hitStats = await hit.stats();
    if (!hitStats.available) throw new Error('expected a measurement');
    expect(hitStats.value.retrievals).toBe(1);
    expect(hitStats.value.totalRequests).toBe(0);

    const miss = createScopedHeadroomAdapter(
      stubAdapter([], { retrieved: false, reason: 'unknown-handle' }),
      'disabled',
    );
    await miss.retrieve('handle-1');
    expect((await miss.stats()).available).toBe(false);
  });

  it('delegates exactly: same kind, same result object, same messages reference', async () => {
    const inner = createNoopHeadroomAdapter('disabled');
    const scoped = createScopedHeadroomAdapter(inner, 'disabled');

    expect(scoped.kind).toBe(inner.kind);

    const messages = [{ role: 'user' as const, content: 'hello' }];
    const result = await scoped.compress({ messages });
    expect(result.messages).toBe(messages);
    expect(result.compressed).toBe(false);
  });

  it('reports the disabled reason for a session whose Headroom is off', async () => {
    const scoped = createScopedHeadroomAdapter(createNoopHeadroomAdapter('disabled'), 'disabled');
    await scoped.compress({ messages: [{ role: 'user', content: 'x' }] });

    const stats = await scoped.stats();
    expect(stats.available).toBe(false);
    if (stats.available) throw new Error('unreachable');
    expect(stats.reason).toBe('disabled');
  });
});

describe('createAggregateHeadroomAdapter', () => {
  function measuredMember(value: HeadroomUsageStats): HeadroomAdapter {
    return {
      ...createNoopHeadroomAdapter('disabled'),
      async stats() {
        return headroomMeasured(value);
      },
    };
  }

  it('sums the scopes underneath it', async () => {
    const aggregate = createAggregateHeadroomAdapter(() => [
      measuredMember({
        totalRequests: 2,
        totalTokensBefore: 1000,
        totalTokensAfter: 400,
        totalTokensSaved: 600,
        retrievals: 1,
      }),
      measuredMember({
        totalRequests: 3,
        totalTokensBefore: 900,
        totalTokensAfter: 300,
        totalTokensSaved: 600,
        retrievals: 2,
      }),
    ]);

    const stats = await aggregate.stats();
    if (!stats.available) throw new Error('expected a measurement');
    expect(stats.value.totalRequests).toBe(5);
    expect(stats.value.totalTokensBefore).toBe(1900);
    expect(stats.value.totalTokensAfter).toBe(700);
    expect(stats.value.totalTokensSaved).toBe(1200);
    expect(stats.value.retrievals).toBe(3);
  });

  it('skips members with nothing to report instead of counting them as zero', async () => {
    const aggregate = createAggregateHeadroomAdapter(() => [
      createNoopHeadroomAdapter('disabled'),
      measuredMember({
        totalRequests: 1,
        totalTokensBefore: 100,
        totalTokensAfter: 40,
        totalTokensSaved: 60,
      }),
    ]);

    const stats = await aggregate.stats();
    if (!stats.available) throw new Error('expected a measurement');
    expect(stats.value.totalRequests).toBe(1);
    expect(stats.value.totalTokensSaved).toBe(60);
    // No member reported retrievals, so the aggregate has none to report.
    expect('retrievals' in stats.value).toBe(false);
  });

  it('is absent when every member is absent, and passes the first reason through', async () => {
    const aggregate = createAggregateHeadroomAdapter(() => [
      createNoopHeadroomAdapter('disabled'),
      createNoopHeadroomAdapter('sdk-unavailable'),
    ]);

    const stats = await aggregate.stats();
    expect(stats.available).toBe(false);
    if (stats.available) throw new Error('unreachable');
    expect(stats.reason).toBe('disabled');
  });

  it('is absent with no members at all', async () => {
    const aggregate = createAggregateHeadroomAdapter(() => []);
    expect((await aggregate.stats()).available).toBe(false);
  });

  it('re-reads its members on every call, so a session that started later is included', async () => {
    const members: HeadroomAdapter[] = [];
    const aggregate = createAggregateHeadroomAdapter(() => members);

    expect((await aggregate.stats()).available).toBe(false);

    members.push(
      measuredMember({
        totalRequests: 1,
        totalTokensBefore: 10,
        totalTokensAfter: 4,
        totalTokensSaved: 6,
      }),
    );

    const stats = await aggregate.stats();
    if (!stats.available) throw new Error('expected a measurement');
    expect(stats.value.totalTokensSaved).toBe(6);
  });

  it('compresses nothing and retrieves nothing — it is a reporting adapter', async () => {
    const aggregate = createAggregateHeadroomAdapter(() => []);
    const messages = [{ role: 'user' as const, content: 'hello' }];

    const result = await aggregate.compress({ messages });
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.stats.available).toBe(false);

    expect(await aggregate.retrieve('h')).toEqual({
      retrieved: false,
      reason: 'service-unavailable',
    });
  });
});
