/**
 * fork(VOR-48) — GET / friendly landing page.
 *
 * Guards the two invariants that make this route safe to expose pre-auth:
 *   1. It serves human-facing HTML (not a 401), for both / and /index.html.
 *   2. It leaks nothing sensitive and does NOT weaken /api/* auth.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { createRouter } from '../../src/router';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';

describe('Root landing page (Integration)', () => {
  let router: (request: Request) => Promise<Response>;

  beforeAll(() => {
    const eventBus = new EventBus();
    const pool = new SessionPool(eventBus);
    router = createRouter(pool);
  });

  test('GET / returns 200 HTML without auth', async () => {
    const res = await router(new Request('http://localhost:3847/', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    // Advertises version and the health link, and shows how to authenticate.
    expect(body).toContain('/health');
    expect(body).toContain('Authorization: Bearer');
  });

  test('GET /index.html also returns the landing page', async () => {
    const res = await router(new Request('http://localhost:3847/index.html', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  test('landing page contains no key material or secrets', async () => {
    const res = await router(new Request('http://localhost:3847/', { method: 'GET' }));
    const body = await res.text();
    // The curl example uses an obvious placeholder, never a real craft_sk_ key.
    expect(body).toContain('craft_sk_YOUR_KEY_HERE');
    expect(body).not.toMatch(/craft_sk_[A-Za-z0-9]{20,}/);
    expect(body.toLowerCase()).not.toContain('keyhash');
  });

  test('curl example reflects the origin the caller used', async () => {
    const res = await router(new Request('http://192.168.1.50:9999/', { method: 'GET' }));
    const body = await res.text();
    expect(body).toContain('http://192.168.1.50:9999/api/workspaces');
  });

  test('POST / is not the landing page (falls through to auth/404)', async () => {
    const res = await router(new Request('http://localhost:3847/', { method: 'POST' }));
    expect(res.status).not.toBe(200);
  });

  test('/api/* remains authenticated (401) — landing page does not weaken it', async () => {
    const res = await router(new Request('http://localhost:3847/api/workspaces', { method: 'GET' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});
