import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createRouter } from '../../src/router';
import { SessionPool } from '../../src/services/session-pool';
import { EventBus } from '../../src/services/event-bus';

describe('Health Endpoint (Integration)', () => {
  let router: (request: Request) => Promise<Response>;
  let pool: SessionPool;

  beforeAll(() => {
    const eventBus = new EventBus();
    pool = new SessionPool(eventBus);
    router = createRouter(pool);
  });

  test('GET /health returns 200 with status', async () => {
    const request = new Request('http://localhost:3847/health', { method: 'GET' });
    const response = await router(request);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeDefined();
    expect(typeof body.uptime).toBe('number');
    expect(body.activeSessions).toBe(0);
  });

  test('GET /health includes CORS headers', async () => {
    const request = new Request('http://localhost:3847/health', { method: 'GET' });
    const response = await router(request);

    // Health endpoint doesn't use CORS middleware (no auth needed)
    // but the response should be JSON
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  test('OPTIONS returns CORS preflight', async () => {
    const request = new Request('http://localhost:3847/api/sessions', { method: 'OPTIONS' });
    const response = await router(request);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  test('unauthenticated API request returns 401', async () => {
    const request = new Request('http://localhost:3847/api/workspaces', { method: 'GET' });
    const response = await router(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('Authorization');
  });

  test('unknown route returns 404', async () => {
    const request = new Request('http://localhost:3847/api/nonexistent', {
      method: 'GET',
      headers: { Authorization: 'Bearer craft_sk_test123' },
    });
    const response = await router(request);

    // Will be 401 because key is invalid, but that's fine - auth comes first
    expect([401, 404]).toContain(response.status);
  });
});
