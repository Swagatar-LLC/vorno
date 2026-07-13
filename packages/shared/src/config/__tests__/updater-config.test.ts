/**
 * fork(PLAN-018 / ADR-0009): updater feed config module tests.
 *
 * CRAFT_CONFIG_DIR is set before the first (dynamic) import of the updater
 * module, whose CONFIG_DIR is frozen at import time (same pattern as the
 * trigger-server supervisor tests).
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod: typeof import('../updater');
let configDir: string;
let configFile: string;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'updater-cfg-'));
  process.env.CRAFT_CONFIG_DIR = configDir;
  mod = await import('../updater');
  configFile = mod.getUpdaterConfigPath();
});

afterEach(() => {
  if (existsSync(configFile)) rmSync(configFile);
});

describe('updater config — defaults', () => {
  test('absent file returns the fork default (Swagatar-LLC/vorno-releases)', () => {
    const cfg = mod.loadUpdaterConfig();
    expect(cfg).toEqual({
      provider: 'github',
      owner: 'Swagatar-LLC',
      repo: 'vorno-releases',
      channel: 'latest',
      autoCheck: true,
    });
  });

  test('exported DEFAULT matches the loaded absent-file config', () => {
    expect(mod.loadUpdaterConfig()).toEqual(mod.DEFAULT_UPDATER_CONFIG);
  });

  test('config path is an absolute updater-config.json', () => {
    // CONFIG_DIR is frozen at first import of the config module, which under the
    // full shared suite may be another test's temp dir — so assert the file name
    // and absoluteness rather than a specific dir.
    expect(configFile.endsWith('updater-config.json')).toBe(true);
    expect(configFile.startsWith('/')).toBe(true);
  });
});

describe('updater config — validation', () => {
  test('rejects a non-object', () => {
    const r = mod.validateUpdaterConfig(42);
    expect(r.ok).toBe(false);
  });

  test('rejects an unknown provider', () => {
    const r = mod.validateUpdaterConfig({ provider: 'gitlab', owner: 'a', repo: 'b' });
    expect(r.ok).toBe(false);
  });

  test('github: requires non-empty owner and repo', () => {
    expect(mod.validateUpdaterConfig({ provider: 'github', owner: '', repo: 'b' }).ok).toBe(false);
    expect(mod.validateUpdaterConfig({ provider: 'github', owner: 'a', repo: '  ' }).ok).toBe(false);
  });

  test('github: accepts valid owner/repo and fills channel + autoCheck defaults', () => {
    const r = mod.validateUpdaterConfig({ provider: 'github', owner: 'acme', repo: 'rel' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({
        provider: 'github',
        owner: 'acme',
        repo: 'rel',
        channel: 'latest',
        autoCheck: true,
      });
    }
  });

  test('generic: requires https url', () => {
    expect(mod.validateUpdaterConfig({ provider: 'generic', url: 'http://x.example/feed' }).ok).toBe(false);
    expect(mod.validateUpdaterConfig({ provider: 'generic', url: 'not a url' }).ok).toBe(false);
    expect(mod.validateUpdaterConfig({ provider: 'generic', url: '' }).ok).toBe(false);
    const r = mod.validateUpdaterConfig({ provider: 'generic', url: 'https://feed.example.com/updates' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.provider).toBe('generic');
  });

  test('rejects a non-boolean autoCheck and a blank channel', () => {
    expect(mod.validateUpdaterConfig({ provider: 'github', owner: 'a', repo: 'b', autoCheck: 'yes' }).ok).toBe(false);
    expect(mod.validateUpdaterConfig({ provider: 'github', owner: 'a', repo: 'b', channel: '  ' }).ok).toBe(false);
  });

  test('honours explicit channel + autoCheck=false', () => {
    const r = mod.validateUpdaterConfig({ provider: 'github', owner: 'a', repo: 'b', channel: 'beta', autoCheck: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.channel).toBe('beta');
      expect(r.config.autoCheck).toBe(false);
    }
  });
});

describe('updater config — persistence', () => {
  test('saveUpdaterConfig persists the normalized shape and round-trips', () => {
    const saved = mod.saveUpdaterConfig({ provider: 'generic', url: 'https://feed.example.com/updates', channel: 'beta' });
    expect(saved).toEqual({ provider: 'generic', url: 'https://feed.example.com/updates', channel: 'beta', autoCheck: true });
    expect(existsSync(configFile)).toBe(true);
    expect(mod.loadUpdaterConfig()).toEqual(saved);
  });

  test('saveUpdaterConfig throws on invalid input (RPC rejection path)', () => {
    expect(() => mod.saveUpdaterConfig({ provider: 'github', owner: '', repo: '' })).toThrow();
    // Nothing was written.
    expect(existsSync(configFile)).toBe(false);
  });

  test('malformed file on disk → defaults, never throws', () => {
    writeFileSync(configFile, '{ this is not valid json ', 'utf-8');
    expect(() => mod.loadUpdaterConfig()).not.toThrow();
    expect(mod.loadUpdaterConfig()).toEqual(mod.DEFAULT_UPDATER_CONFIG);
  });

  test('structurally-invalid file on disk → defaults', () => {
    writeFileSync(configFile, JSON.stringify({ provider: 'github', owner: '', repo: '' }), 'utf-8');
    expect(mod.loadUpdaterConfig()).toEqual(mod.DEFAULT_UPDATER_CONFIG);
  });
});
