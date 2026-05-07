import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../storage.ts';
import type { WorkspaceConfig } from '../types.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

describe('workspace storage: token-usage thresholds (PLAN-003)', () => {
  it('loads existing configs without thresholds (forward-compat: fields stay undefined)', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-thresholds-missing-'));
    tempDirs.push(workspaceRoot);

    // Pre-PLAN-003 config — no thresholds field at all
    const rawConfig = {
      id: 'ws_legacy',
      name: 'Legacy Workspace',
      slug: 'legacy',
      defaults: {
        model: 'claude-sonnet-4-5',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.tokenUsageThresholds).toBeUndefined();
    expect(loaded?.defaults?.tokenUsageModelOverrides).toBeUndefined();
    // Pre-existing fields still load fine
    expect(loaded?.defaults?.model).toBe('claude-sonnet-4-5');
  });

  it('round-trips both threshold maps cleanly', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-thresholds-roundtrip-'));
    tempDirs.push(workspaceRoot);

    const config: WorkspaceConfig = {
      id: 'ws_full',
      name: 'Full Thresholds',
      slug: 'full-thresholds',
      defaults: {
        tokenUsageThresholds: {
          anthropic: { warn: 0.5, danger: 0.75 },
          pi: { warn: 0.4, danger: 0.85 },
        },
        tokenUsageModelOverrides: {
          'claude-sonnet-4-5': { warn: 0.3, danger: 0.6 },
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveWorkspaceConfig(workspaceRoot, config);
    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded?.defaults?.tokenUsageThresholds).toEqual({
      anthropic: { warn: 0.5, danger: 0.75 },
      pi: { warn: 0.4, danger: 0.85 },
    });
    expect(loaded?.defaults?.tokenUsageModelOverrides).toEqual({
      'claude-sonnet-4-5': { warn: 0.3, danger: 0.6 },
    });

    // The on-disk JSON should contain the new fields verbatim
    const onDisk = JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf-8'));
    expect(onDisk.defaults.tokenUsageThresholds.anthropic.warn).toBe(0.5);
  });

  it('loads partial settings (provider-only) without inventing model overrides', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-thresholds-partial-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_partial',
      name: 'Partial',
      slug: 'partial',
      defaults: {
        tokenUsageThresholds: {
          anthropic: { warn: 0.55, danger: 0.85 },
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded?.defaults?.tokenUsageThresholds?.anthropic).toEqual({ warn: 0.55, danger: 0.85 });
    expect(loaded?.defaults?.tokenUsageModelOverrides).toBeUndefined();
  });
});
