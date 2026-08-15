/**
 * Context-profile config loading — fork(PLAN-030 Phase 3).
 *
 * The theme running through these cases: an invalid profile must produce **no** profile,
 * never a partially-applied one. A profile carries a permission mode, so half-accepting
 * one is materially worse than rejecting it.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getContextProfile,
  getContextProfilesConfigPath,
  loadContextProfilesConfig,
  saveContextProfilesConfig,
} from './storage.ts';

let root: string;
let warnings: string[];
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

function writeConfig(raw: unknown): void {
  mkdirSync(join(root, 'context-profiles'), { recursive: true });
  writeFileSync(getContextProfilesConfigPath(root), JSON.stringify(raw), 'utf-8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctxprof-'));
  warnings = [];
  warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.join(' '));
  });
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('loadContextProfilesConfig', () => {
  test('a workspace with no config file has no profiles (not an error)', () => {
    expect(loadContextProfilesConfig(root)).toEqual({ version: 1, profiles: [] });
    expect(warnings).toEqual([]);
  });

  test('round-trips a valid config', () => {
    const config = {
      version: 1 as const,
      profiles: [
        { id: 'steward', name: 'Steward repo', workingDirectory: '/tmp/steward', sources: ['dev'] },
      ],
    };
    saveContextProfilesConfig(root, config);
    expect(loadContextProfilesConfig(root)).toEqual(config);
    expect(getContextProfile(root, 'steward')?.workingDirectory).toBe('/tmp/steward');
  });

  test('getContextProfile returns null for an id the workspace does not declare', () => {
    saveContextProfilesConfig(root, { version: 1, profiles: [{ id: 'a', sources: [] }] });
    expect(getContextProfile(root, 'b')).toBeNull();
  });

  test('unparseable JSON yields no profiles rather than throwing into the executor', () => {
    mkdirSync(join(root, 'context-profiles'), { recursive: true });
    writeFileSync(getContextProfilesConfigPath(root), '{ not json', 'utf-8');
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
  });

  test('one invalid profile invalidates the whole file — no partial acceptance', () => {
    writeConfig({
      version: 1,
      profiles: [
        { id: 'good', permissionMode: 'safe' },
        { id: 'bad', permissionMode: 'god-mode' },
      ],
    });
    // The valid sibling is NOT admitted. Accepting it would mean a typo silently changes
    // which profiles exist, and `apply-context` would report success for a file the
    // operator has not actually got right.
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
    expect(warnings.join('\n')).toContain('permissionMode');
  });

  test('an unknown profile key is rejected, not passed through', () => {
    writeConfig({ version: 1, profiles: [{ id: 'a', sources: ['dev'], workingDirectorie: '/tmp' }] });
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
    expect(warnings.join('\n')).toContain('workingDirectorie');
  });

  test('a "skills" key is rejected with an explanation, not a bare unrecognized-key error', () => {
    writeConfig({ version: 1, profiles: [{ id: 'a', sources: ['dev'], skills: ['ponytail'] }] });
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
    const text = warnings.join('\n');
    // The message must say *why*, or the next person just adds the field again.
    expect(text).toContain('[skill:<slug>]');
    expect(text).toContain('PLAN-032');
  });

  test('a profile that sets no knob is rejected — it would be a silent no-op rule', () => {
    writeConfig({ version: 1, profiles: [{ id: 'empty', name: 'Empty' }] });
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
  });

  test('duplicate profile ids are rejected — resolution would depend on file order', () => {
    writeConfig({
      version: 1,
      profiles: [
        { id: 'dup', permissionMode: 'safe' },
        { id: 'dup', permissionMode: 'allow-all' },
      ],
    });
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
    expect(warnings.join('\n')).toContain('unique');
  });

  test('every permission mode the product supports parses', () => {
    for (const mode of ['safe', 'ask', 'allow-all'] as const) {
      writeConfig({ version: 1, profiles: [{ id: 'p', permissionMode: mode }] });
      expect(getContextProfile(root, 'p')?.permissionMode).toBe(mode);
    }
  });

  test('an unversioned config is rejected rather than assumed to be v1', () => {
    writeConfig({ profiles: [{ id: 'a', sources: [] }] });
    expect(loadContextProfilesConfig(root).profiles).toEqual([]);
  });
});
