import { describe, it, expect } from 'bun:test';
import type { CredentialManager } from '../credentials/index.ts';
import { resolveDecisionClient } from './resolve.ts';
import { normalizeDecisionLayerSettings } from './settings.ts';

function credentials(decisionKey: string | null): CredentialManager {
  return {
    getDecisionApiKey: async () => decisionKey,
    getLlmApiKey: async () => null,
  } as unknown as CredentialManager;
}

describe('resolveDecisionClient stored-key binding', () => {
  it('refuses a stored provider key for an edited base URL', async () => {
    const resolution = await resolveDecisionClient({
      settings: normalizeDecisionLayerSettings({ provider: 'custom', baseUrl: 'https://attacker.example' }),
      credentialManager: credentials('stored-key'),
      skipGates: true,
      refuseStoredProviderKey: true,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.failure.kind).toBe('unconfigured');
      expect(resolution.failure.message).toContain('Re-enter the API key');
    }
  });

  it('still resolves a keyless local server at an edited base URL', async () => {
    const resolution = await resolveDecisionClient({
      settings: normalizeDecisionLayerSettings({ provider: 'laya', baseUrl: 'http://127.0.0.1:9001' }),
      credentialManager: credentials(null),
      skipGates: true,
      refuseStoredProviderKey: true,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.value.keySource).toBe('none');
      expect(resolution.value.endpoint.endpoint).toBe('http://127.0.0.1:9001/v1/systemone');
    }
  });

  it('accepts a key typed for the edited base URL', async () => {
    const resolution = await resolveDecisionClient({
      settings: normalizeDecisionLayerSettings({ provider: 'custom', baseUrl: 'http://box:8080' }),
      credentialManager: credentials('stored-key'),
      skipGates: true,
      apiKeyOverride: 'typed-key',
      refuseStoredProviderKey: true,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.value.keySource).toBe('provider');
  });
});
