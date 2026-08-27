/**
 * The fallback half of the Headroom boundary (SUV-0015).
 *
 * These tests are the executable form of the SUV's central claim: Headroom being
 * absent or disabled is an ordinary, fully-functional state of Vorno. They cover
 * the factory's two degradation paths and the no-op's "unchanged in, nothing
 * fabricated out" contract.
 *
 * The real-SDK round-trip lives in `sdk-roundtrip.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import type {
  HeadroomCompressRequest,
  HeadroomMessage,
} from '@craft-agent/core/types';
import { createHeadroomAdapter } from '../index.ts';
import { createNoopHeadroomAdapter } from '../noop-adapter.ts';
import type { HeadroomSdkModule } from '../sdk-adapter.ts';

/**
 * A loader whose dynamic import genuinely fails to resolve.
 *
 * Deliberately not `async () => { throw new Error('nope') }`: a hand-thrown
 * error proves the catch block runs, not that a *missing package* is survivable.
 * This produces the real thing — Bun/Node's module-resolution rejection for a
 * specifier that is not installed — which is the situation a build shipped
 * without the optional SDK is actually in.
 */
const ABSENT_PACKAGE = 'headroom-ai-not-installed-in-this-repo';

// Held in a variable rather than written inline: a literal specifier makes
// `tsc` resolve it at compile time and fail with TS2307, which would break the
// typecheck gate over a module whose whole purpose is to be missing.
const loadAbsentSdk: () => Promise<HeadroomSdkModule> = () =>
  import(ABSENT_PACKAGE) as Promise<HeadroomSdkModule>;

/** A representative payload: bulky tool output plus surrounding turn. */
const TOOL_OUTPUT = JSON.stringify({
  files: Array.from({ length: 40 }, (_, i) => ({
    path: `packages/shared/src/generated/module-${i}.ts`,
    bytes: 1024 + i,
    summary: 'lorem ipsum dolor sit amet, consectetur adipiscing elit',
  })),
});

const MESSAGES: readonly HeadroomMessage[] = Object.freeze([
  { role: 'system', content: 'You are Vorno.' },
  { role: 'user', content: 'List the generated modules.' },
  { role: 'tool', content: TOOL_OUTPUT, toolCallId: 'call_abc123', name: 'Glob' },
]);

const REQUEST: HeadroomCompressRequest = { messages: MESSAGES, model: 'claude-opus-5' };

describe('createHeadroomAdapter — degradation paths (SUV-0015)', () => {
  it('returns the no-op adapter when Headroom is disabled, without loading the SDK', async () => {
    let loaderCalled = false;
    const adapter = await createHeadroomAdapter(
      { enabled: false },
      {
        loadSdk: () => {
          loaderCalled = true;
          return loadAbsentSdk();
        },
      },
    );

    expect(adapter.kind).toBe('noop');
    // Disabled must be decided before any dynamic import: the cost of Headroom
    // being off should be zero, not "one failed module resolution per session".
    expect(loaderCalled).toBe(false);
  });

  it('returns the no-op adapter when the SDK package is absent, and does not throw', async () => {
    // Prove the premise first: the specifier really does fail to resolve.
    await expect(loadAbsentSdk()).rejects.toThrow();

    const adapter = await createHeadroomAdapter(
      { enabled: true, baseUrl: 'http://127.0.0.1:1' },
      { loadSdk: loadAbsentSdk },
    );

    expect(adapter.kind).toBe('noop');
  });

  it('reports the absent SDK as `sdk-unavailable`, distinct from `disabled`', async () => {
    const absent = await createHeadroomAdapter(
      { enabled: true },
      { loadSdk: loadAbsentSdk },
    );
    const off = await createHeadroomAdapter({ enabled: false });

    const absentStats = await absent.stats();
    const offStats = await off.stats();

    expect(absentStats).toEqual({ available: false, reason: 'sdk-unavailable' });
    expect(offStats).toEqual({ available: false, reason: 'disabled' });
  });

  it('returns the no-op adapter when the SDK resolves but has no HeadroomClient export', async () => {
    // What an SDK upgrade that moved its entry point looks like at runtime.
    const adapter = await createHeadroomAdapter(
      { enabled: true },
      { loadSdk: async () => ({}) as unknown as HeadroomSdkModule },
    );

    expect(adapter.kind).toBe('noop');
    expect(await adapter.stats()).toEqual({
      available: false,
      reason: 'sdk-unavailable',
    });
  });

  it('returns the no-op adapter when constructing the client throws', async () => {
    const adapter = await createHeadroomAdapter(
      { enabled: true },
      {
        loadSdk: async () =>
          ({
            HeadroomClient: class {
              constructor() {
                throw new Error('constructor exploded');
              }
            },
          }) as unknown as HeadroomSdkModule,
      },
    );

    expect(adapter.kind).toBe('noop');
  });

  it('is fully usable after every failure path — no method throws', async () => {
    const adapter = await createHeadroomAdapter(
      { enabled: true },
      { loadSdk: loadAbsentSdk },
    );

    // The point of the SUV: a caller needs no try/catch and no branch on `kind`.
    const compressed = await adapter.compress(REQUEST);
    const retrieved = await adapter.retrieve('some-handle');
    const stats = await adapter.stats();

    expect(compressed.messages).toEqual(MESSAGES);
    expect(retrieved.retrieved).toBe(false);
    expect(stats.available).toBe(false);
  });
});

describe('no-op adapter — unchanged in, nothing fabricated out (SUV-0015)', () => {
  it('returns the exact messages it was given from compress', async () => {
    const adapter = createNoopHeadroomAdapter();
    const result = await adapter.compress(REQUEST);

    // Same reference: not merely equal, but literally untouched.
    expect(result.messages).toBe(MESSAGES);
    // And byte-identical when serialized, which is what a call site downstream
    // actually ships to a model.
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(MESSAGES));
    expect(result.compressed).toBe(false);
  });

  it('issues no retrieval handles, because it extracted nothing', async () => {
    const result = await createNoopHeadroomAdapter().compress(REQUEST);
    expect(result.retrievalHandles).toEqual([]);
  });

  it('reports compress stats as absent, never as zeros', async () => {
    const result = await createNoopHeadroomAdapter().compress(REQUEST);

    expect(result.stats.available).toBe(false);
    // The specific regression this guards: a `tokensSaved: 0` that a token
    // surface would render as "Headroom saved 0 tokens" when in truth Headroom
    // never ran. The absent arm must carry no numbers at all.
    expect(result.stats).toEqual({ available: false, reason: 'disabled' });
    expect(Object.keys(result.stats)).toEqual(['available', 'reason']);
    expect(JSON.stringify(result.stats)).not.toContain('0');
  });

  it('reports usage stats as absent, never as zeros', async () => {
    const stats = await createNoopHeadroomAdapter().stats();

    expect(stats).toEqual({ available: false, reason: 'disabled' });
    expect(Object.keys(stats)).toEqual(['available', 'reason']);
    // A caller reading `.value` gets `undefined`, which is unusable by accident —
    // as opposed to a zero, which is unusable on purpose and looks like data.
    expect((stats as { value?: unknown }).value).toBeUndefined();
  });

  it('does not alter or invent content on retrieve — it reports the miss', async () => {
    const result = await createNoopHeadroomAdapter().retrieve('handle-from-elsewhere');

    // A no-op holds no store. Echoing the handle back as content, or returning
    // an empty string, would hand a model silently wrong context — the most
    // damaging form of the fabrication the plan forbids.
    expect(result).toEqual({ retrieved: false, reason: 'disabled' });
  });

  it('carries the construction reason through every operation', async () => {
    const adapter = createNoopHeadroomAdapter('sdk-unavailable');

    expect((await adapter.compress(REQUEST)).stats).toEqual({
      available: false,
      reason: 'sdk-unavailable',
    });
    expect(await adapter.retrieve('h')).toEqual({
      retrieved: false,
      reason: 'sdk-unavailable',
    });
    expect(await adapter.stats()).toEqual({
      available: false,
      reason: 'sdk-unavailable',
    });
  });
});
