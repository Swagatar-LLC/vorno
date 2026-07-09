/**
 * fork(PLAN-014) — /hooks route adapter mapping tests.
 */

import { describe, test, expect } from 'bun:test';
import { handleWebhookRoute } from '../../src/routes/hooks';
import type { WebhooksHandle } from '../../src/webhooks/init';
import type { WebhookResult } from '@craft-agent/shared/automations';

function stub(result: WebhookResult): WebhooksHandle {
  return { handle: async () => result, dispose: async () => {} };
}

function post(): Request {
  return new Request('http://x/hooks/ws/slug/tok', { method: 'POST', body: '{"a":1}' });
}

const params = { workspace: 'ws', hookSlug: 'slug', token: 'tok' };

describe('handleWebhookRoute', () => {
  test('202 → JSON eventId', async () => {
    const res = await handleWebhookRoute(post(), params, stub({ status: 202, body: { eventId: 'e1' } }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ eventId: 'e1' });
  });

  test('200 duplicate', async () => {
    const res = await handleWebhookRoute(post(), params, stub({ status: 200, body: { duplicate: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true });
  });

  test('404 uniform', async () => {
    const res = await handleWebhookRoute(post(), params, stub({ status: 404 }));
    expect(res.status).toBe(404);
  });

  test('413 body cap', async () => {
    const res = await handleWebhookRoute(post(), params, stub({ status: 413 }));
    expect(res.status).toBe(413);
  });

  test('429 carries Retry-After', async () => {
    const res = await handleWebhookRoute(post(), params, stub({ status: 429, retryAfterSeconds: 42 }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });
});
