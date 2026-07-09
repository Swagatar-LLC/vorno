/**
 * fork(PLAN-014) — webhook-ingest unit tests.
 * Covers jsonpath-lite, tokens, dedup ladder + TTL, rate gate, ingest queue,
 * and the full receiver pipeline (auth uniformity, body cap, dedup, rate,
 * 202-fast ordering, and restart drain).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveJsonPathLite, resolveJsonPathLiteString, isValidJsonPathLite } from './jsonpath-lite.ts';
import { generateHookToken, hashHookToken, tokensMatch } from './tokens.ts';
import { extractIdempotencyKey, WebhookDedupStore } from './dedup.ts';
import { WebhookRateGate } from './rate-gate.ts';
import { WebhookIngestQueue } from './ingest-queue.ts';
import { createWebhookReceiver, type WebhookRequest, type ResolvedWorkspace } from './receiver.ts';
import type { AutomationMatcher, HookConfig } from '../types.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'p14-'));
}
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
describe('jsonpath-lite', () => {
  const body = { type: 'Issue.created', issue: { id: 'LIN-42', tags: ['a', 'b'] } };

  test('resolves nested + array + root', () => {
    expect(resolveJsonPathLite(body, '$')).toBe(body);
    expect(resolveJsonPathLite(body, '$.type')).toBe('Issue.created');
    expect(resolveJsonPathLite(body, '$.issue.id')).toBe('LIN-42');
    expect(resolveJsonPathLite(body, '$.issue.tags[1]')).toBe('b');
    expect(resolveJsonPathLite(body, '$.nope')).toBeUndefined();
  });

  test('stringifies for match/env use', () => {
    expect(resolveJsonPathLiteString(body, '$.type')).toBe('Issue.created');
    expect(resolveJsonPathLiteString(body, '$.issue')).toBe(JSON.stringify(body.issue));
    expect(resolveJsonPathLiteString(body, '$.nope')).toBe('');
  });

  test('validates syntax', () => {
    expect(isValidJsonPathLite('$')).toBe(true);
    expect(isValidJsonPathLite('$.a.b')).toBe(true);
    expect(isValidJsonPathLite('$.a[0]')).toBe(true);
    expect(isValidJsonPathLite('a.b')).toBe(false);
    expect(isValidJsonPathLite('$.')).toBe(false);
    expect(isValidJsonPathLite('$.a[x]')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('tokens', () => {
  test('mint → hash shape + constant-time compare', () => {
    const { token, tokenHash, tokenPrefix } = generateHookToken();
    expect(token.startsWith('craft_whk_')).toBe(true);
    expect(tokenHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(tokenPrefix.startsWith('craft_whk_...')).toBe(true);
    expect(tokensMatch(token, tokenHash)).toBe(true);
    expect(tokensMatch(token + 'x', tokenHash)).toBe(false);
    expect(hashHookToken(token)).toBe(tokenHash);
  });
});

// ---------------------------------------------------------------------------
describe('dedup', () => {
  const hookBase: HookConfig = { slug: 'h', tokenHash: 'sha256:' + 'a'.repeat(64) };

  test('key ladder: header → body → content hash', () => {
    const raw = bytes('{"id":"abc"}');
    const parsed = { id: 'abc' };

    const headerHook: HookConfig = { ...hookBase, idempotencyKey: { source: 'header', name: 'X-Delivery' } };
    expect(extractIdempotencyKey(headerHook, { 'x-delivery': 'd1' }, raw, parsed)).toBe('d1');

    const bodyHook: HookConfig = { ...hookBase, idempotencyKey: { source: 'body', name: '$.id' } };
    expect(extractIdempotencyKey(bodyHook, {}, raw, parsed)).toBe('abc');

    // fallback content hash when configured source is absent
    const missHook: HookConfig = { ...hookBase, idempotencyKey: { source: 'header', name: 'X-Delivery' } };
    expect(extractIdempotencyKey(missHook, {}, raw, parsed)).toMatch(/^sha256:/);
  });

  test('store: record/has + TTL expiry + restart survival', () => {
    const dir = tmp();
    try {
      let clock = 1_000;
      const store = new WebhookDedupStore(dir, { ttlMs: 100, now: () => clock });
      expect(store.has('e1')).toBe(false);
      store.record('e1');
      expect(store.has('e1')).toBe(true);

      // Restart: a fresh store reads the JSONL.
      const store2 = new WebhookDedupStore(dir, { ttlMs: 100, now: () => clock });
      expect(store2.has('e1')).toBe(true);

      // Advance beyond TTL → expired.
      clock += 200;
      expect(store2.has('e1')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('rate gate', () => {
  test('admits up to perMinute+burst then 429 with Retry-After', () => {
    let clock = 0;
    const gate = new WebhookRateGate(() => clock);
    const key = 'ws:hook';
    for (let i = 0; i < 3; i++) expect(gate.check(key, 2, 1).allowed).toBe(true); // 2 + burst 1
    const denied = gate.check(key, 2, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Window slides forward → admits again.
    clock += 61_000;
    expect(gate.check(key, 2, 1).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ingest queue', () => {
  test('append/listPending/markComplete/compact + restart', () => {
    const dir = tmp();
    try {
      const q = new WebhookIngestQueue(dir);
      const mk = (id: string) => ({
        eventId: id,
        workspaceId: 'ws',
        payload: { workspaceId: 'ws', timestamp: 1, hookId: 'h', hookSlug: 's', eventId: id, headers: {}, body: {} },
        createdAt: 1,
      });
      q.append(mk('a'));
      q.append(mk('b'));
      expect(q.listPending().map((e) => e.eventId).sort()).toEqual(['a', 'b']);
      q.markComplete('a');
      expect(q.listPending().map((e) => e.eventId)).toEqual(['b']);

      // Restart survives.
      const q2 = new WebhookIngestQueue(dir);
      expect(q2.listPending().map((e) => e.eventId)).toEqual(['b']);
      q2.compact();
      const q3 = new WebhookIngestQueue(dir);
      expect(q3.listPending().map((e) => e.eventId)).toEqual(['b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('receiver pipeline', () => {
  function makeHook(tokenHash: string, extra?: Partial<HookConfig>): AutomationMatcher {
    return {
      id: 'm1',
      hook: { slug: 'linear', tokenHash, ...extra },
      actions: [{ type: 'prompt', prompt: 'triage' }],
    };
  }

  function setup(matcher: AutomationMatcher | null, onWebhookEvent = async () => {}) {
    const dir = tmp();
    const ws: ResolvedWorkspace = { workspaceId: 'ws1', rootPath: dir };
    const receiver = createWebhookReceiver({
      resolveWorkspace: (n) => (n === 'my-workspace' ? ws : null),
      loadHooks: () => (matcher ? [matcher] : []),
      onWebhookEvent,
    });
    return { dir, ws, receiver };
  }

  function req(over: Partial<WebhookRequest> & { token: string }): WebhookRequest {
    return {
      workspace: 'my-workspace',
      hookSlug: 'linear',
      headers: {},
      rawBody: bytes('{"type":"Issue.created"}'),
      ...over,
    };
  }

  test('happy path → 202 + onWebhookEvent + queue append precedes response (202-fast)', async () => {
    const { token, tokenHash } = generateHookToken();
    let resolveEvent: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveEvent = r; });
    let called = false;
    const { dir, receiver } = setup(makeHook(tokenHash), async () => {
      called = true;
      await gate; // simulate slow executor
    });
    try {
      const res = await receiver.handle(req({ token }));
      expect(res.status).toBe(202);
      // Response returned BEFORE the slow executor settled → 202-fast.
      expect(called).toBe(true);
      // The delivery was durably enqueued before the response.
      const queueFile = readFileSync(join(dir, 'webhooks-ingest.jsonl'), 'utf-8');
      expect(queueFile).toContain('"eventId"');
      resolveEvent();
    } finally {
      receiver.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uniform 404 for unknown workspace / slug / bad token / disabled', async () => {
    const { token, tokenHash } = generateHookToken();
    // unknown workspace
    {
      const { dir, receiver } = setup(makeHook(tokenHash));
      expect((await receiver.handle(req({ token, workspace: 'nope' }))).status).toBe(404);
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
    // unknown slug
    {
      const { dir, receiver } = setup(makeHook(tokenHash));
      expect((await receiver.handle(req({ token, hookSlug: 'ghost' }))).status).toBe(404);
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
    // bad token
    {
      const { dir, receiver } = setup(makeHook(tokenHash));
      expect((await receiver.handle(req({ token: 'craft_whk_wrong' }))).status).toBe(404);
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
    // disabled matcher
    {
      const m = makeHook(tokenHash); m.enabled = false;
      const { dir, receiver } = setup(m);
      expect((await receiver.handle(req({ token }))).status).toBe(404);
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
  });

  test('413 over body cap', async () => {
    const { token, tokenHash } = generateHookToken();
    const { dir, receiver } = setup(makeHook(tokenHash, { bodyCapBytes: 8 }));
    try {
      const res = await receiver.handle(req({ token, rawBody: bytes('x'.repeat(100)) }));
      expect(res.status).toBe(413);
    } finally {
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
  });

  test('duplicate delivery → 200 {duplicate:true}', async () => {
    const { token, tokenHash } = generateHookToken();
    const { dir, receiver } = setup(makeHook(tokenHash, { idempotencyKey: { source: 'header', name: 'x-delivery' } }));
    try {
      const first = await receiver.handle(req({ token, headers: { 'x-delivery': 'd-001' } }));
      expect(first.status).toBe(202);
      const second = await receiver.handle(req({ token, headers: { 'x-delivery': 'd-001' } }));
      expect(second.status).toBe(200);
      if (second.status === 200) expect(second.body.duplicate).toBe(true);
    } finally {
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
  });

  test('429 over rate limit + Retry-After', async () => {
    const { token, tokenHash } = generateHookToken();
    const { dir, receiver } = setup(makeHook(tokenHash, {
      rateLimit: { perMinute: 1, burst: 0 },
      idempotencyKey: { source: 'header', name: 'x-delivery' },
    }));
    try {
      expect((await receiver.handle(req({ token, headers: { 'x-delivery': 'r1' } }))).status).toBe(202);
      const limited = await receiver.handle(req({ token, headers: { 'x-delivery': 'r2' } }));
      expect(limited.status).toBe(429);
      if (limited.status === 429) expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      receiver.dispose(); rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restart drain retries a delivery whose executor failed', async () => {
    const { token, tokenHash } = generateHookToken();
    const dir = tmp();
    const ws: ResolvedWorkspace = { workspaceId: 'ws1', rootPath: dir };
    let attempts = 0;
    // First receiver: executor always throws → entry stays pending.
    const failing = createWebhookReceiver({
      resolveWorkspace: () => ws,
      loadHooks: () => [makeHook(tokenHash)],
      onWebhookEvent: async () => { attempts++; throw new Error('boom'); },
    });
    try {
      await failing.handle(req({ token }));
      // Give the fire-and-forget process() a tick to run + persist the failure.
      await new Promise((r) => setTimeout(r, 20));
      failing.dispose();
      expect(attempts).toBeGreaterThanOrEqual(1);

      // "Restart": a new receiver drains the still-pending entry, this time succeeding.
      let drained = 0;
      const recovering = createWebhookReceiver({
        resolveWorkspace: () => ws,
        loadHooks: () => [makeHook(tokenHash)],
        onWebhookEvent: async () => { drained++; },
      });
      await recovering.drainPending([ws]);
      await new Promise((r) => setTimeout(r, 20));
      recovering.dispose();
      expect(drained).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
