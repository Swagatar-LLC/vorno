/**
 * fork(PLAN-014) — /hooks route MOUNTING regression guard (LEARNING-018).
 *
 * The pre-auth `POST /hooks/...` route is composed into the router ONLY when a
 * `WebhooksHandle` is passed. Both hosts share this exact `createRouter` seam
 * (standalone Bun via `createTriggerServer`, embedded Electron via the supervisor
 * threading `webhooks` into the same core), so proving it here proves the fix for
 * the embedded host too — the packaged app 401'd because it omitted this handle.
 *
 *  - webhooks present → the route is mounted; a hook request routes into the
 *    handle (asserted via a stub returning 202), and an unknown target the handle
 *    reports as 404 surfaces as 404 — NOT the auth gate's 401.
 *  - webhooks absent  → POST /hooks falls through to the auth gate → 401.
 */

import { describe, test, expect } from 'bun:test';
import { createRouter } from '../../src/router';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';
import { ClientRegistry } from '../../src/transport/client-registry';
import type { WebhooksHandle } from '../../src/webhooks/init';
import type { WebhookResult } from '@craft-agent/shared/automations';

function makeRouter(webhooks?: WebhooksHandle) {
  const eventBus = new EventBus();
  const pool = new SessionPool(eventBus);
  const registry = new ClientRegistry();
  return createRouter(pool, registry, webhooks);
}

function post(path = '/hooks/ws/slug/tok'): Request {
  return new Request(`http://localhost:3847${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

function stubHandle(result: WebhookResult): WebhooksHandle {
  return { handle: async () => result, dispose: async () => {} };
}

describe('/hooks route mounting (LEARNING-018)', () => {
  test('webhooks handle present → route mounted, delivery reaches the handle (202)', async () => {
    const router = makeRouter(stubHandle({ status: 202, body: { eventId: 'e1' } }));
    const res = await router(post());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ eventId: 'e1' });
  });

  test('webhooks handle present → handle 404 surfaces as 404, not the auth gate', async () => {
    const router = makeRouter(stubHandle({ status: 404 }));
    const res = await router(post());
    expect(res.status).toBe(404);
  });

  test('webhooks handle ABSENT → POST /hooks falls to the auth gate → 401 (the bug state)', async () => {
    const router = makeRouter(undefined);
    const res = await router(post());
    expect(res.status).toBe(401);
  });

  test('GET /hooks is never the webhook route (POST-only gate)', async () => {
    const router = makeRouter(stubHandle({ status: 202, body: { eventId: 'e1' } }));
    const res = await router(new Request('http://localhost:3847/hooks/ws/slug/tok', { method: 'GET' }));
    expect(res.status).not.toBe(202);
  });
});
