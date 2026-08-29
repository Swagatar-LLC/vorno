/**
 * Memory config persistence + end-to-end resolution (fork: PLAN-040, SUV-0029).
 *
 * Two halves:
 *   1. Plain workspace-config round-trip via load/saveWorkspaceConfig.
 *   2. End-to-end `loadEffectiveMemoryConfig()` against a real on-disk
 *      config dir, run in a subprocess with `CRAFT_CONFIG_DIR` set — the
 *      idiom from `storage-headroom.test.ts`, required because
 *      `config/paths.ts` freezes CONFIG_DIR at module-eval (LEARNING-056).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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

// ------------------------------------------------------------------
// 1. Workspace-level persistence
// ------------------------------------------------------------------

describe('workspace storage: memory overrides (SUV-0029)', () => {
  it('loads pre-PLAN-040 configs with the field simply absent', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-memory-missing-'));
    tempDirs.push(workspaceRoot);

    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify(
        {
          id: 'ws_legacy',
          name: 'Legacy Workspace',
          slug: 'legacy',
          defaults: { model: 'claude-sonnet-4-5' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.memory).toBeUndefined();
    expect(loaded?.defaults?.model).toBe('claude-sonnet-4-5');
  });

  it('round-trips a full memory override cleanly', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-memory-roundtrip-'));
    tempDirs.push(workspaceRoot);

    const config: WorkspaceConfig = {
      id: 'ws_memory',
      name: 'Memory Workspace',
      slug: 'memory',
      defaults: {
        memory: {
          enabled: true,
          provider: 'headroom-mcp',
          topK: 12,
          autoLoad: false,
          autoSave: true,
          decayHalfLifeDays: 30,
          includeArchived: true,
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveWorkspaceConfig(workspaceRoot, config);

    expect(loadWorkspaceConfig(workspaceRoot)?.defaults?.memory).toEqual({
      enabled: true,
      provider: 'headroom-mcp',
      topK: 12,
      autoLoad: false,
      autoSave: true,
      decayHalfLifeDays: 30,
      includeArchived: true,
    });

    const onDisk = JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf-8'));
    expect(onDisk.defaults.memory.provider).toBe('headroom-mcp');
    expect(onDisk.defaults.memory.topK).toBe(12);
  });

  it('round-trips a partial override without inventing the unset fields', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-memory-partial-'));
    tempDirs.push(workspaceRoot);

    saveWorkspaceConfig(workspaceRoot, {
      id: 'ws_partial',
      name: 'Partial',
      slug: 'partial',
      defaults: { memory: { topK: 3 } },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const memory = loadWorkspaceConfig(workspaceRoot)?.defaults?.memory;
    expect(memory).toEqual({ topK: 3 });
    expect(memory).not.toHaveProperty('enabled');
  });

  it('keeps memory and headroom as independent sibling sections', () => {
    // The whole point of ADR-0031 alternative A: memory is not a subsection of
    // Headroom, so writing one must not touch or require the other.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-memory-sibling-'));
    tempDirs.push(workspaceRoot);

    saveWorkspaceConfig(workspaceRoot, {
      id: 'ws_sibling',
      name: 'Sibling',
      slug: 'sibling',
      defaults: {
        headroom: { enabled: false },
        memory: { enabled: true },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const defaults = loadWorkspaceConfig(workspaceRoot)?.defaults;
    expect(defaults?.memory).toEqual({ enabled: true });
    expect(defaults?.headroom).toEqual({ enabled: false });

    const onDisk = JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf-8'));
    expect(onDisk.defaults.headroom).not.toHaveProperty('memory');
  });
});

// ------------------------------------------------------------------
// 2. End-to-end resolution against a real config dir
// ------------------------------------------------------------------

const MEMORY_MODULE = pathToFileURL(join(import.meta.dir, '..', 'memory.ts')).href;
const STORAGE_MODULE = pathToFileURL(
  join(import.meta.dir, '..', '..', 'config', 'storage.ts'),
).href;

interface ConfigDirOptions {
  /** Written to the config-root config.json as the `memory` key. */
  instance?: unknown;
  /** Written to the workspace config.json as `defaults.memory`. */
  workspace?: unknown;
  /** Skip writing the config-root config.json entirely (fresh install). */
  omitRootConfig?: boolean;
  /** Skip writing the workspace config.json entirely (fresh install). */
  omitWorkspaceConfig?: boolean;
}

function setupConfigDir(options: ConfigDirOptions = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-memory-'));
  tempDirs.push(configDir);
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace');
  mkdirSync(workspaceRoot, { recursive: true });

  if (!options.omitWorkspaceConfig) {
    const defaults: Record<string, unknown> = {};
    if (options.workspace !== undefined) defaults.memory = options.workspace;
    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify(
        {
          id: 'ws-config-1',
          name: 'My Workspace',
          slug: 'my-workspace',
          defaults,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  if (!options.omitRootConfig) {
    const rootConfig: Record<string, unknown> = {
      workspaces: [
        { id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() },
      ],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [],
    };
    if (options.instance !== undefined) rootConfig.memory = options.instance;
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(rootConfig, null, 2), 'utf-8');
  }

  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify(
      {
        version: 'test',
        description: 'test defaults',
        defaults: {
          notificationsEnabled: true,
          colorTheme: 'default',
          autoCapitalisation: true,
          sendMessageKey: 'enter',
          spellCheck: false,
          keepAwakeWhileRunning: false,
          richToolDescriptions: true,
        },
        workspaceDefaults: {
          thinkingLevel: 'off',
          permissionMode: 'ask',
          cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
          localMcpServers: { enabled: true },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  return { configDir, workspaceRoot, configPath: join(configDir, 'config.json') };
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `import { loadEffectiveMemoryConfig } from '${MEMORY_MODULE}';` +
        `import { getMemoryInstanceConfig, setMemoryInstanceConfig } from '${STORAGE_MODULE}';` +
        code,
    ],
    {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  if (run.exitCode !== 0) {
    throw new Error(
      `subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`,
    );
  }

  return run.stdout.toString().trim();
}

function resolveIn(configDir: string, workspaceRoot?: string): Record<string, unknown> {
  const arg = workspaceRoot ? JSON.stringify(workspaceRoot) : '';
  return JSON.parse(
    runEval(configDir, `console.log(JSON.stringify(loadEffectiveMemoryConfig(${arg})))`),
  );
}

const DISABLED = {
  enabled: false,
  provider: 'builtin-markdown',
  topK: 5,
  autoLoad: true,
  autoSave: true,
  decayHalfLifeDays: 60,
  includeArchived: false,
};

describe('loadEffectiveMemoryConfig (SUV-0029)', () => {
  it('resolves to disabled on a fresh install with neither config file present', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      omitRootConfig: true,
      omitWorkspaceConfig: true,
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('resolves to disabled when both files exist but carry no memory key', () => {
    const { configDir, workspaceRoot } = setupConfigDir();
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('reads the instance base config from the config root', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { enabled: true, provider: 'headroom-mcp' },
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      ...DISABLED,
      enabled: true,
      provider: 'headroom-mcp',
    });
  });

  it('lets the workspace file override the instance file field-by-field', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { enabled: true, topK: 20, includeArchived: true },
      workspace: { topK: 3 },
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      enabled: true, // inherited from instance
      provider: 'builtin-markdown', // set nowhere
      topK: 3, // workspace wins
      autoLoad: true, // set nowhere
      autoSave: true, // set nowhere
      decayHalfLifeDays: 60, // set nowhere
      includeArchived: true, // inherited from instance
    });
  });

  it('ignores workspace overrides when no workspace root is supplied', () => {
    const { configDir } = setupConfigDir({
      instance: { enabled: true },
      workspace: { enabled: false },
    });
    expect(resolveIn(configDir).enabled).toBe(true);
  });

  it('resolves a malformed on-disk config to disabled without throwing', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { enabled: 'yes', topK: 'five', mysteryKnob: [1, 2] },
      workspace: 'not-an-object',
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('resolves an unknown on-disk provider to the disabled default', () => {
    // A hand-edited config.json naming a provider we do not ship must not
    // half-apply: the layer goes, and with it the `enabled: true` beside it.
    const { configDir, workspaceRoot } = setupConfigDir({
      workspace: { enabled: true, provider: 'faiss' },
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('does not clamp an out-of-range on-disk number', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { topK: 25 },
      workspace: { topK: 5000 },
    });
    // Instance value, not 50.
    expect(resolveIn(configDir, workspaceRoot).topK).toBe(25);
  });

  it('persists the instance base config through setMemoryInstanceConfig', () => {
    const { configDir, configPath, workspaceRoot } = setupConfigDir();

    runEval(
      configDir,
      `setMemoryInstanceConfig({ enabled: true, topK: 9 });` +
        `console.log(JSON.stringify(getMemoryInstanceConfig()))`,
    );

    // Landed in the real config.json at the config root
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(onDisk.memory).toEqual({ enabled: true, topK: 9 });

    // And a separate process resolves it
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      ...DISABLED,
      enabled: true,
      topK: 9,
    });
  });

  it('clears the instance base config back to unset', () => {
    const { configDir, configPath } = setupConfigDir({ instance: { enabled: true } });

    runEval(configDir, `setMemoryInstanceConfig(undefined)`);

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(onDisk).not.toHaveProperty('memory');
    expect(resolveIn(configDir).enabled).toBe(false);
  });

  it('leaves an existing headroom section untouched when writing memory', () => {
    const { configDir, configPath } = setupConfigDir();

    runEval(
      configDir,
      `import { setHeadroomInstanceConfig } from '${STORAGE_MODULE}';` +
        `setHeadroomInstanceConfig({ enabled: true });` +
        `setMemoryInstanceConfig({ enabled: true });`,
    );

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(onDisk.headroom).toEqual({ enabled: true });
    expect(onDisk.memory).toEqual({ enabled: true });
  });
});
