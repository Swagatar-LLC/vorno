/**
 * Round-trip through the real adapter and the real pinned SDK (SUV-0015).
 *
 * Compress a representative tool-output payload, redeem the handle the service
 * hands back, and require the original content byte-for-byte.
 *
 * ## What is real here, and what is not — read this before trusting the test
 *
 * SUV-0014's finding F4 is the constraint: `headroom-ai` is a thin HTTP client
 * for the Headroom proxy, not an in-process compression engine. There is no way
 * to exercise it without something answering on the other end of `baseUrl`.
 *
 * So this suite runs the **real `createHeadroomAdapter` factory, the real
 * dynamic import of the pinned `headroom-ai@0.36.5`, the real `HeadroomClient`,
 * and the real request/response codec** (body construction, the proxy's
 * snake_case wire format, the SDK's camelCase conversion, its error mapping)
 * against a local HTTP server that speaks the proxy's CCR protocol. What is
 * substituted is the compression *service*, not the SDK — the same boundary any
 * hermetic test of an HTTP client has to draw. Concretely: this catches an SDK
 * upgrade that renames a wire field, changes an endpoint path, or alters the
 * result shape. It does not measure real compression ratios, and does not claim
 * to; that is PLAN-040 I0's benchmark work (SUV-0025).
 *
 * The last mile is available and opt-in rather than pretended: set
 * `HEADROOM_TEST_BASE_URL` to a running proxy and the final block runs the same
 * assertions against it. It is skipped, loudly, when unset — a live service is
 * not a CI dependency this repo should take.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { HeadroomAdapter, HeadroomMessage } from '@craft-agent/core/types';
import { createHeadroomAdapter } from '../index.ts';

// ---------------------------------------------------------------------------
// Payload — a realistic bulky tool result, the case Headroom exists for
// ---------------------------------------------------------------------------

const TOOL_OUTPUT = JSON.stringify(
  {
    matches: Array.from({ length: 60 }, (_, i) => ({
      file: `packages/shared/src/sources/handlers/handler-${i}.ts`,
      line: i * 7 + 3,
      text: `export async function handle${i}(request: SourceRequest): Promise<SourceResponse> {`,
      context: 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod',
    })),
    truncated: false,
    // Non-ASCII and quoting, so "byte-identical" is a real claim about encoding
    // and JSON escaping rather than a claim about plain ASCII.
    note: 'naïve — “quoted” \\ backslash \u0000 nul \t tab 🎯',
  },
  null,
  2,
);

const MESSAGES: readonly HeadroomMessage[] = Object.freeze([
  { role: 'system', content: 'You are Vorno.' },
  { role: 'user', content: 'Find every source handler.' },
  { role: 'tool', content: TOOL_OUTPUT, toolCallId: 'call_grep_1', name: 'Grep' },
]);

// ---------------------------------------------------------------------------
// A local stand-in for the Headroom proxy, speaking its documented wire format
// ---------------------------------------------------------------------------

/** Compressed stub the proxy substitutes for extracted content. */
function stubFor(hash: string, original: string): string {
  return `[headroom: ${original.length} bytes extracted, retrieve with hash ${hash}]`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface StubProxy {
  baseUrl: string;
  stop: () => void;
  /** Bodies the SDK actually sent, so the request codec is assertable too. */
  compressRequests: unknown[];
}

/**
 * Serve `/v1/compress` and `/v1/retrieve` with CCR semantics: extract oversized
 * tool content into a content-addressed store, hand back a stub plus its hash,
 * and return the stored original verbatim on redemption.
 *
 * Everything on the wire is snake_case, as the Python proxy emits — the SDK is
 * what converts. Getting that wrong is one of the drifts this test can catch.
 */
function startStubProxy(): StubProxy {
  const store = new Map<string, string>();
  const compressRequests: unknown[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/v1/compress') {
        const body = (await request.json()) as { messages?: unknown[]; model?: string };
        compressRequests.push(body);

        const incoming = Array.isArray(body.messages) ? body.messages : [];
        const hashes: string[] = [];
        const messages: unknown[] = [];
        let before = 0;
        let after = 0;

        for (const raw of incoming) {
          const message = raw as Record<string, unknown>;
          const content = typeof message.content === 'string' ? message.content : '';
          before += content.length;

          if (message.role === 'tool' && content.length > 200) {
            const hash = await sha256Hex(content);
            store.set(hash, content);
            hashes.push(hash);
            const stub = stubFor(hash, content);
            after += stub.length;
            messages.push({ ...message, content: stub });
          } else {
            after += content.length;
            messages.push(message);
          }
        }

        return Response.json({
          messages,
          tokens_before: Math.ceil(before / 4),
          tokens_after: Math.ceil(after / 4),
          tokens_saved: Math.ceil(before / 4) - Math.ceil(after / 4),
          compression_ratio: after / before,
          transforms_applied: ['ccr'],
          ccr_hashes: hashes,
        });
      }

      if (url.pathname === '/v1/retrieve') {
        const body = (await request.json()) as { hash?: string };
        const original = body.hash === undefined ? undefined : store.get(body.hash);
        if (original === undefined) {
          return Response.json({ error: { type: 'not_found', message: 'no such hash' } }, {
            status: 404,
          });
        }
        return Response.json({
          hash: body.hash,
          original_content: original,
          original_tokens: Math.ceil(original.length / 4),
          original_item_count: 1,
          compressed_item_count: 1,
          tool_name: 'Grep',
          retrieval_count: 1,
        });
      }

      if (url.pathname === '/stats') {
        return Response.json({
          total_requests: 1,
          total_tokens_before: 100,
          total_tokens_after: 40,
          total_tokens_saved: 60,
          average_compression_ratio: 0.4,
          cache_hits: 0,
          by_mode: {},
        });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    compressRequests,
  };
}

// ---------------------------------------------------------------------------
// Real network, in a suite that shares a process with global `fetch` mocks
// ---------------------------------------------------------------------------

/**
 * Guarantee this file's HTTP calls actually leave the process.
 *
 * `bun test` runs the whole `packages/shared` suite in one process, and three
 * existing test files install a `globalThis.fetch` mock without restoring it:
 *
 *   - `src/sources/__tests__/oauth-relay.test.ts`
 *   - `src/sources/__tests__/oauth-callback-url.test.ts`
 *   - `src/sources/__tests__/api-tools-credential-freshness.test.ts`
 *
 * The `oauth-relay` mock answers every unrecognised URL with `404 Not Found`.
 * Nothing noticed until now because no other test made a real HTTP request;
 * these tests are the first, and they fail in a full run while passing in
 * isolation. The pinned SDK calls the global `fetch`, so the leak silently
 * replaced the local stub proxy with a blanket 404.
 *
 * The leak is a pre-existing hygiene bug in those files and fixing it belongs in
 * its own change, not in this SUV. What this suite is entitled to do is defend
 * its own preconditions: `Bun.fetch` is the native implementation and is not
 * reachable by whoever reassigned the global, so installing it for the duration
 * makes these tests order-independent. The previous value is put back afterwards
 * so nothing downstream sees a different environment because of us.
 */
function useRealFetch(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = Bun.fetch as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

describe('real adapter + pinned SDK round-trip (SUV-0015)', () => {
  let proxy: StubProxy;
  let adapter: HeadroomAdapter;
  let restoreFetch: () => void;

  beforeAll(async () => {
    restoreFetch = useRealFetch();
    proxy = startStubProxy();
    // No `loadSdk` override: this resolves the real `headroom-ai` package.
    adapter = await createHeadroomAdapter({
      enabled: true,
      baseUrl: proxy.baseUrl,
      model: 'claude-opus-5',
      timeoutMs: 10_000,
    });
  });

  afterAll(() => {
    proxy.stop();
    restoreFetch();
  });

  it('uses the SDK-backed adapter, not the no-op', () => {
    expect(adapter.kind).toBe('sdk');
  });

  it('compresses a tool-output payload and returns handles for the extracted content', async () => {
    const result = await adapter.compress({ messages: MESSAGES });

    expect(result.compressed).toBe(true);
    expect(result.retrievalHandles.length).toBe(1);

    const tool = result.messages.find((message) => message.role === 'tool');
    expect(tool).toBeDefined();
    // The payload really left the message — otherwise "retrieve the original"
    // would be a round-trip over content that never went anywhere.
    expect(tool?.content).not.toBe(TOOL_OUTPUT);
    expect(tool?.content.length).toBeLessThan(TOOL_OUTPUT.length);

    // Non-compressible turns survive untouched.
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are Vorno.' });
  });

  it('retrieves the original content byte-for-byte', async () => {
    const compressed = await adapter.compress({ messages: MESSAGES });
    const handle = compressed.retrievalHandles[0];
    expect(handle).toBeDefined();

    const retrieved = await adapter.retrieve(handle as string);

    expect(retrieved.retrieved).toBe(true);
    if (!retrieved.retrieved) throw new Error('unreachable');

    expect(retrieved.content).toBe(TOOL_OUTPUT);
    // Byte-level, not string-level: catches any encoding round-trip damage to
    // the non-ASCII and escaped characters in the payload.
    expect(new TextEncoder().encode(retrieved.content)).toEqual(
      new TextEncoder().encode(TOOL_OUTPUT),
    );
  });

  it('preserves the tool-call correlation id across the round trip', async () => {
    const result = await adapter.compress({ messages: MESSAGES });
    const tool = result.messages.find((message) => message.role === 'tool');

    expect(tool?.role).toBe('tool');
    expect(tool?.role === 'tool' ? tool.toolCallId : undefined).toBe('call_grep_1');
  });

  it('sends the messages in the proxy wire format the SDK documents', async () => {
    await adapter.compress({ messages: MESSAGES, model: 'gpt-4o' });
    const body = proxy.compressRequests.at(-1) as {
      model?: string;
      messages?: Record<string, unknown>[];
    };

    expect(body.model).toBe('gpt-4o');
    // snake_case `tool_call_id`, not the boundary's camelCase `toolCallId`. If an
    // SDK upgrade stops converting, this is where it shows up.
    expect(body.messages?.[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_grep_1',
    });
  });

  it('reports measured stats, with numbers that come from the response', async () => {
    const result = await adapter.compress({ messages: MESSAGES });

    expect(result.stats.available).toBe(true);
    if (!result.stats.available) throw new Error('unreachable');
    expect(result.stats.value.tokensSaved).toBeGreaterThan(0);
    expect(result.stats.value.tokensBefore).toBeGreaterThan(result.stats.value.tokensAfter);
    expect(result.stats.value.transformsApplied).toEqual(['ccr']);
  });

  it('reports a miss for a handle the service does not hold', async () => {
    const result = await adapter.retrieve('0'.repeat(64));
    // Reachable service, absent content — distinct from being unable to ask.
    expect(result).toEqual({ retrieved: false, reason: 'unknown-handle' });
  });
});

describe('real adapter against an unreachable service (SUV-0015)', () => {
  let restoreFetch: () => void;

  // Same reason as above: a leaked `fetch` mock would answer 404 here, which
  // would look like `unknown-handle` instead of the connection failure this test
  // is actually about.
  beforeAll(() => {
    restoreFetch = useRealFetch();
  });
  afterAll(() => restoreFetch());

  it('passes content through unchanged and reports stats absent, never zeros', async () => {
    // Port 1 is reserved and never listening: a genuinely dead endpoint.
    const adapter = await createHeadroomAdapter({
      enabled: true,
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
    });

    expect(adapter.kind).toBe('sdk');

    const result = await adapter.compress({ messages: MESSAGES });

    // This is the case the SDK itself answers with `tokensBefore: 0,
    // tokensSaved: 0, compressionRatio: 1` when its default `fallback: true` is
    // left on. The boundary turns those fabricated zeros off and reports the
    // truth instead — that nothing was measured.
    expect(result.compressed).toBe(false);
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(MESSAGES));
    expect(result.stats).toEqual({ available: false, reason: 'service-unavailable' });
    expect(result.retrievalHandles).toEqual([]);

    expect(await adapter.retrieve('anything')).toEqual({
      retrieved: false,
      reason: 'service-unavailable',
    });
    expect(await adapter.stats()).toEqual({
      available: false,
      reason: 'service-unavailable',
    });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Opt-in: the same round trip against a genuinely running Headroom proxy.
// ---------------------------------------------------------------------------

const LIVE_BASE_URL = process.env.HEADROOM_TEST_BASE_URL;

describe.skipIf(!LIVE_BASE_URL)('live Headroom proxy round-trip (opt-in)', () => {
  let restoreFetch: () => void;

  beforeAll(() => {
    restoreFetch = useRealFetch();
  });
  afterAll(() => restoreFetch());

  it('retrieves the original tool output byte-for-byte', async () => {
    const adapter = await createHeadroomAdapter({
      enabled: true,
      baseUrl: LIVE_BASE_URL,
      model: 'gpt-4o',
      timeoutMs: 30_000,
    });

    const compressed = await adapter.compress({ messages: MESSAGES });
    expect(compressed.compressed).toBe(true);

    const handle = compressed.retrievalHandles[0];
    // A live proxy configured without CCR extraction would legitimately return
    // no handles; that is a configuration statement, not a failure of ours.
    if (handle === undefined) {
      expect(compressed.retrievalHandles).toEqual([]);
      return;
    }

    const retrieved = await adapter.retrieve(handle);
    expect(retrieved.retrieved).toBe(true);
    if (!retrieved.retrieved) throw new Error('unreachable');
    expect(retrieved.content).toBe(TOOL_OUTPUT);
  }, 60_000);
});
