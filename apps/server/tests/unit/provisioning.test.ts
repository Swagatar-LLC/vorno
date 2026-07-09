import { describe, test, expect, afterEach } from 'bun:test';
import {
  getFlagValue,
  hasFlag,
  parseGenerateApiKeyArgs,
  provisionLlmKey,
  VALID_POLICIES,
} from '../../src/provisioning';
import { applyEnvOverrides, type ServerConfig } from '../../src/config';

// NOTE: The disk-writing (generateApiKeyCommand → saveServerConfig) and
// machine-bound-vault (provisionLlmKey happy path) branches are intentionally
// NOT exercised here — they write into the resolved CONFIG_DIR, which is shared
// process-wide under `bun test`. Those paths are verified end-to-end in the
// Docker PoC against a throwaway volume (see docs/server-deployment.md).

describe('provisioning CLI arg parsing', () => {
  describe('getFlagValue', () => {
    test('returns the value following a flag', () => {
      expect(getFlagValue(['--policy', 'allow-safe'], '--policy')).toBe('allow-safe');
    });

    test('returns undefined when the flag is absent', () => {
      expect(getFlagValue(['--other', 'x'], '--policy')).toBeUndefined();
    });

    test('treats a following flag as no value (not the next flag name)', () => {
      // `--generate-api-key --policy allow-safe` → name is missing, not "--policy"
      expect(getFlagValue(['--generate-api-key', '--policy'], '--generate-api-key')).toBeUndefined();
    });

    test('returns undefined when the flag is the last token', () => {
      expect(getFlagValue(['--generate-api-key'], '--generate-api-key')).toBeUndefined();
    });
  });

  describe('hasFlag', () => {
    test('detects presence', () => {
      expect(hasFlag(['--show-config'], '--show-config')).toBe(true);
      expect(hasFlag(['--other'], '--show-config')).toBe(false);
    });
  });

  describe('parseGenerateApiKeyArgs', () => {
    const defaults = { maxConcurrentSessions: 5 };

    test('parses name with default policy and empty workspace scope (all)', () => {
      const r = parseGenerateApiKeyArgs(['--generate-api-key', 'ci-trigger'], defaults);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.name).toBe('ci-trigger');
      expect(r.value.permissions.permissionPolicy).toBe('allow-safe');
      expect(r.value.permissions.workspaceIds).toEqual([]);
      expect(r.value.permissions.maxConcurrentSessions).toBe(5);
    });

    test('fails when the key name is missing', () => {
      const r = parseGenerateApiKeyArgs(['--generate-api-key'], defaults);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/Missing key name/);
    });

    test('rejects an invalid policy', () => {
      const r = parseGenerateApiKeyArgs(['--generate-api-key', 'k', '--policy', 'yolo'], defaults);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/Invalid --policy/);
    });

    test('accepts every valid policy', () => {
      for (const policy of VALID_POLICIES) {
        const r = parseGenerateApiKeyArgs(['--generate-api-key', 'k', '--policy', policy], defaults);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.permissions.permissionPolicy).toBe(policy);
      }
    });

    test('parses and trims a comma-separated workspace scope', () => {
      const r = parseGenerateApiKeyArgs(
        ['--generate-api-key', 'k', '--workspaces', 'poc, other , '],
        defaults,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.permissions.workspaceIds).toEqual(['poc', 'other']);
    });

    test('honors --max-concurrent override', () => {
      const r = parseGenerateApiKeyArgs(['--generate-api-key', 'k', '--max-concurrent', '2'], defaults);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.permissions.maxConcurrentSessions).toBe(2);
    });

    test('rejects a non-positive --max-concurrent', () => {
      const r = parseGenerateApiKeyArgs(['--generate-api-key', 'k', '--max-concurrent', '0'], defaults);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/max-concurrent/);
    });
  });

  describe('provisionLlmKey guard', () => {
    test('rejects an empty key before touching the vault', async () => {
      await expect(provisionLlmKey('anthropic-api', '   ')).rejects.toThrow(/No API key/);
    });
  });
});

describe('config env overrides (CRAFT_TRIGGER_HOST/PORT)', () => {
  afterEach(() => {
    delete process.env.CRAFT_TRIGGER_HOST;
    delete process.env.CRAFT_TRIGGER_PORT;
  });

  function base(): ServerConfig {
    return {
      enabled: true,
      host: '127.0.0.1',
      port: 3847,
      apiKeys: [],
      rateLimits: { requestsPerMinute: 30, concurrentSessions: 5 },
    };
  }

  test('leaves config unchanged when no env is set', () => {
    const c = applyEnvOverrides(base());
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3847);
  });

  test('overrides host', () => {
    process.env.CRAFT_TRIGGER_HOST = '0.0.0.0';
    expect(applyEnvOverrides(base()).host).toBe('0.0.0.0');
  });

  test('overrides port with a valid value', () => {
    process.env.CRAFT_TRIGGER_PORT = '8080';
    expect(applyEnvOverrides(base()).port).toBe(8080);
  });

  test('ignores an out-of-range port and keeps the configured value', () => {
    process.env.CRAFT_TRIGGER_PORT = '70000';
    expect(applyEnvOverrides(base()).port).toBe(3847);
  });

  test('ignores a non-numeric port', () => {
    process.env.CRAFT_TRIGGER_PORT = 'abc';
    expect(applyEnvOverrides(base()).port).toBe(3847);
  });
});
