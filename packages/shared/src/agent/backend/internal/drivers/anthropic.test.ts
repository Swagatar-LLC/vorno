import { afterEach, describe, expect, it } from 'bun:test';
import { anthropicDriver } from './anthropic.ts';
import { inferAnthropicContextWindow } from '../../../../config/models.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('anthropicDriver.fetchModels', () => {
  it('filters deprecated Opus 4.5 but keeps Opus 4.6, and prefers Opus 4.8 as default', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-4-6',
      last_id: 'claude-sonnet-4-6',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-opus-4-8');
    expect(result.models.map(m => m.id)).toEqual([
      'claude-opus-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    const opus48 = result.models.find(m => m.id === 'claude-opus-4-8')!;
    expect(opus48.name).toBe('Opus 4.8');
    expect(opus48.contextWindow).toBe(1_000_000);
    const opus46 = result.models.find(m => m.id === 'claude-opus-4-6')!;
    expect(opus46.name).toBe('Opus 4.6');
    expect(opus46.contextWindow).toBe(200_000);
  });

  it('infers a 1M context window for a brand-new Opus not yet in the registry', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-5-0-20260901', display_name: 'Claude Opus 5.0', created_at: '2026-09-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-5-0-20260901', display_name: 'Claude Sonnet 5.0', created_at: '2026-09-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-5-0-20260901',
      last_id: 'claude-sonnet-5-0-20260901',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic', name: 'Anthropic', providerType: 'anthropic', authType: 'api_key', createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    const opus = result.models.find(m => m.id === 'claude-opus-5-0-20260901')!;
    const sonnet = result.models.find(m => m.id === 'claude-sonnet-5-0-20260901')!;
    expect(opus.contextWindow).toBe(1_000_000); // would have been the flat 200k default before
    expect(sonnet.contextWindow).toBe(200_000);
  });
});

describe('inferAnthropicContextWindow', () => {
  it('returns 1M for Opus (bare, dated, and Bedrock-native ids) and 200k otherwise', () => {
    expect(inferAnthropicContextWindow('claude-opus-9-9-20270101')).toBe(1_000_000);
    expect(inferAnthropicContextWindow('us.anthropic.claude-opus-4-8')).toBe(1_000_000);
    expect(inferAnthropicContextWindow('claude-sonnet-9-0')).toBe(200_000);
    expect(inferAnthropicContextWindow('claude-haiku-9-0')).toBe(200_000);
    expect(inferAnthropicContextWindow('some-unknown-model')).toBe(200_000);
  });
});

describe('anthropicDriver.fetchModels — OAuth (Claude subscription) connections', () => {
  const oauthConnection = {
    slug: 'claude-max',
    name: 'Claude Max',
    providerType: 'anthropic',
    authType: 'oauth',
    createdAt: Date.now(),
  } as any;

  it('never calls /v1/models — subscription OAuth is not entitled to that endpoint', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{"type":"error"}', { status: 401, statusText: 'Unauthorized' });
    }) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: oauthConnection,
      credentials: { oauthAccessToken: 'sk-ant-oat01-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(called).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('serves the registry so a newly released model reaches the picker', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch must not be called for OAuth connections');
    }) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: oauthConnection,
      credentials: { oauthAccessToken: 'sk-ant-oat01-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    const ids = result.models.map(m => m.id);
    // The reported defect: Fable 5.1 shipped and could never appear on an OAuth connection.
    expect(ids).toContain('claude-fable-5-1');
    // Regression guard: the model Jeff actually runs on must not be dropped.
    expect(ids).toContain('claude-opus-5');
  });

  it('still hits the API for OAuth connections pointed at a custom gateway', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({
        data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' }],
        has_more: false, first_id: 'claude-opus-4-8', last_id: 'claude-opus-4-8',
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await anthropicDriver.fetchModels!({
      connection: { ...oauthConnection, baseUrl: 'https://gateway.internal' },
      credentials: { oauthAccessToken: 'sk-ant-oat01-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(calledUrl).toContain('https://gateway.internal/v1/models');
  });

  it('leaves API-key connections on the live endpoint', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({
        data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' }],
        has_more: false, first_id: 'claude-opus-4-8', last_id: 'claude-opus-4-8',
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await anthropicDriver.fetchModels!({
      connection: { ...oauthConnection, authType: 'api_key' },
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(called).toBe(true);
  });
});
