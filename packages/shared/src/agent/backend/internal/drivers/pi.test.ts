import { afterEach, describe, expect, it } from 'bun:test';
import { piDriver } from './pi.ts';

const originalFetch = globalThis.fetch;

function openAiConnection() {
  return {
    slug: 'openai',
    name: 'OpenAI',
    providerType: 'pi',
    authType: 'api_key',
    piAuthProvider: 'openai',
    createdAt: Date.now(),
  } as any;
}

const fetchArgs = {
  connection: openAiConnection(),
  credentials: { apiKey: 'sk-test' },
  hostRuntime: {} as any,
  resolvedPaths: {} as any,
  timeoutMs: 15_000,
};

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});

describe('piDriver.fetchModels OpenAI live enumeration', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('enumerates live /v1/models, filters non-chat, and pi/-prefixes the ids', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-5' },
        { id: 'o3' },
        { id: 'text-embedding-3-large' },
        { id: 'gpt-4o' },
        { id: 'whisper-1' },
        { id: 'dall-e-3' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await piDriver.fetchModels!(fetchArgs);
    const ids = result.models.map(m => m.id);

    expect(ids).toContain('pi/gpt-5');
    expect(ids).toContain('pi/o3');
    expect(ids).not.toContain('pi/gpt-4o');
    expect(ids).not.toContain('pi/text-embedding-3-large');
    expect(ids).not.toContain('pi/whisper-1');
    expect(result.models.every(m => m.id.startsWith('pi/') && m.provider === 'pi')).toBe(true);
  });

  it('falls back to the static SDK catalog when the live fetch fails', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

    const result = await piDriver.fetchModels!(fetchArgs);

    // Static catalog (getPiModelsForAuthProvider('openai')) — non-empty, all pi/-prefixed.
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every(m => m.id.startsWith('pi/'))).toBe(true);
  });

  it('falls back to the static catalog when the live list has no selectable models', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'gpt-4o' }],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await piDriver.fetchModels!(fetchArgs);

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every(m => m.id.startsWith('pi/'))).toBe(true);
    // None of the filtered-out live ids should appear.
    expect(result.models.map(m => m.id)).not.toContain('pi/text-embedding-3-large');
  });
});
