/**
 * Headroom config persistence + end-to-end resolution (fork: PLAN-040, SUV-0016).
 *
 * Two halves:
 *   1. Plain workspace-config round-trip via load/saveWorkspaceConfig.
 *   2. End-to-end `loadEffectiveHeadroomConfig()` against a real on-disk
 *      config dir, run in a subprocess with `CRAFT_CONFIG_DIR` set — the
 *      idiom from `config/__tests__/default-thinking-level.test.ts`, required
 *      because `config/paths.ts` freezes CONFIG_DIR at module-eval
 *      (LEARNING-056).
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

describe('workspace storage: headroom overrides (SUV-0016)', () => {
  it('loads pre-PLAN-040 configs with the field simply absent', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-headroom-missing-'));
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
    expect(loaded?.defaults?.headroom).toBeUndefined();
    expect(loaded?.defaults?.model).toBe('claude-sonnet-4-5');
  });

  it('round-trips a full headroom override cleanly', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-headroom-roundtrip-'));
    tempDirs.push(workspaceRoot);

    const config: WorkspaceConfig = {
      id: 'ws_headroom',
      name: 'Headroom Workspace',
      slug: 'headroom',
      defaults: {
        headroom: {
          enabled: true,
          compressionEngines: ['summarize', 'trim'],
          verbosity: 'terse',
          exposeStats: true,
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveWorkspaceConfig(workspaceRoot, config);

    expect(loadWorkspaceConfig(workspaceRoot)?.defaults?.headroom).toEqual({
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    });

    const onDisk = JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf-8'));
    expect(onDisk.defaults.headroom.compressionEngines).toEqual(['summarize', 'trim']);
  });

  it('round-trips a partial override without inventing the unset fields', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-headroom-partial-'));
    tempDirs.push(workspaceRoot);

    saveWorkspaceConfig(workspaceRoot, {
      id: 'ws_partial',
      name: 'Partial',
      slug: 'partial',
      defaults: { headroom: { verbosity: 'verbose' } },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const headroom = loadWorkspaceConfig(workspaceRoot)?.defaults?.headroom;
    expect(headroom).toEqual({ verbosity: 'verbose' });
    expect(headroom).not.toHaveProperty('enabled');
  });
});

// ------------------------------------------------------------------
// 2. End-to-end resolution against a real config dir
// ------------------------------------------------------------------

const HEADROOM_MODULE = pathToFileURL(join(import.meta.dir, '..', 'headroom.ts')).href;
const STORAGE_MODULE = pathToFileURL(
  join(import.meta.dir, '..', '..', 'config', 'storage.ts'),
).href;

interface ConfigDirOptions {
  /** Written to the config-root config.json as the `headroom` key. */
  instance?: unknown;
  /** Written to the workspace config.json as `defaults.headroom`. */
  workspace?: unknown;
  /** Skip writing the config-root config.json entirely (fresh install). */
  omitRootConfig?: boolean;
  /** Skip writing the workspace config.json entirely (fresh install). */
  omitWorkspaceConfig?: boolean;
}

function setupConfigDir(options: ConfigDirOptions = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-headroom-'));
  tempDirs.push(configDir);
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace');
  mkdirSync(workspaceRoot, { recursive: true });

  if (!options.omitWorkspaceConfig) {
    const defaults: Record<string, unknown> = {};
    if (options.workspace !== undefined) defaults.headroom = options.workspace;
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
    if (options.instance !== undefined) rootConfig.headroom = options.instance;
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
      `import { loadEffectiveHeadroomConfig } from '${HEADROOM_MODULE}';` +
        `import { getHeadroomInstanceConfig, setHeadroomInstanceConfig } from '${STORAGE_MODULE}';` +
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
    runEval(configDir, `console.log(JSON.stringify(loadEffectiveHeadroomConfig(${arg})))`),
  );
}

const DISABLED = {
  enabled: false,
  compressionEngines: [],
  verbosity: 'balanced',
  exposeStats: false,
};

describe('loadEffectiveHeadroomConfig (SUV-0016)', () => {
  it('resolves to disabled on a fresh install with neither config file present', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      omitRootConfig: true,
      omitWorkspaceConfig: true,
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('resolves to disabled when both files exist but carry no headroom key', () => {
    const { configDir, workspaceRoot } = setupConfigDir();
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('reads the instance base config from the config root', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { enabled: true, compressionEngines: ['summarize'] },
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      enabled: true,
      compressionEngines: ['summarize'],
      verbosity: 'balanced',
      exposeStats: false,
    });
  });

  it('lets the workspace file override the instance file field-by-field', () => {
    const { configDir, workspaceRoot } = setupConfigDir({
      instance: { enabled: true, verbosity: 'terse', exposeStats: true },
      workspace: { verbosity: 'verbose' },
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      enabled: true, // inherited from instance
      compressionEngines: [], // set nowhere
      verbosity: 'verbose', // workspace wins
      exposeStats: true, // inherited from instance
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
      instance: { enabled: 'yes', verbosity: 42, mysteryKnob: [1, 2] },
      workspace: 'not-an-object',
    });
    expect(resolveIn(configDir, workspaceRoot)).toEqual(DISABLED);
  });

  it('persists the instance base config through setHeadroomInstanceConfig', () => {
    const { configDir, configPath, workspaceRoot } = setupConfigDir();

    runEval(
      configDir,
      `setHeadroomInstanceConfig({ enabled: true, verbosity: 'terse' });` +
        `console.log(JSON.stringify(getHeadroomInstanceConfig()))`,
    );

    // Landed in the real config.json at the config root
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(onDisk.headroom).toEqual({ enabled: true, verbosity: 'terse' });

    // And a separate process resolves it
    expect(resolveIn(configDir, workspaceRoot)).toEqual({
      enabled: true,
      compressionEngines: [],
      verbosity: 'terse',
      exposeStats: false,
    });
  });

  it('clears the instance base config back to unset', () => {
    const { configDir, configPath } = setupConfigDir({ instance: { enabled: true } });

    runEval(configDir, `setHeadroomInstanceConfig(undefined)`);

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(onDisk).not.toHaveProperty('headroom');
    expect(resolveIn(configDir).enabled).toBe(false);
  });
});
