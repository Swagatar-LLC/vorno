import { describe, expect, it } from 'bun:test';
import { LIVE_FETCH_PI_AUTH_PROVIDERS, isLiveFetchPiConnection } from './model-fetcher.ts';
import type { LlmConnection } from './llm-connections.ts';

function conn(partial: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'c',
    name: 'C',
    providerType: 'pi',
    authType: 'api_key',
    createdAt: 0,
    ...partial,
  } as LlmConnection;
}

describe('isLiveFetchPiConnection', () => {
  it('is true for Pi OpenAI and Pi Copilot connections', () => {
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi', piAuthProvider: 'openai' }))).toBe(true);
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi', piAuthProvider: 'github-copilot' }))).toBe(true);
  });

  it('is false for static-catalog Pi providers', () => {
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi', piAuthProvider: 'google' }))).toBe(false);
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi', piAuthProvider: 'xai' }))).toBe(false);
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi', piAuthProvider: undefined }))).toBe(false);
  });

  it('is false for non-Pi provider types even with a matching auth provider', () => {
    expect(isLiveFetchPiConnection(conn({ providerType: 'anthropic', piAuthProvider: 'openai' }))).toBe(false);
    expect(isLiveFetchPiConnection(conn({ providerType: 'pi_compat', piAuthProvider: 'openai' }))).toBe(false);
  });

  it('exposes the canonical live-fetch provider set', () => {
    expect([...LIVE_FETCH_PI_AUTH_PROVIDERS]).toEqual(['github-copilot', 'openai']);
  });
});
