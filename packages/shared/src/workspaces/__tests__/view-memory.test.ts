/**
 * `loadMemoryConfigView()` — the read side of the workspace settings surface
 * (fork: PLAN-040, SUV-0029; ADR-0031).
 *
 * Everything the memory settings section displays comes from this one call:
 * the effective config, what each field would revert to if its override were
 * cleared, and which layer supplied each effective value. The UI derives none
 * of it, so these tests are the real coverage for "shows where the value came
 * from" and "clearing reverts to the instance value".
 *
 * Runs in a subprocess with `CRAFT_CONFIG_DIR` set, the idiom
 * `view-headroom.test.ts` established — `config/paths.ts` freezes CONFIG_DIR
 * at module-eval, so the env var has to be claimed before any import
 * (LEARNING-056).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

const MEMORY_MODULE = pathToFileURL(join(import.meta.dir, '..', 'memory.ts')).href;

const DISABLED = {
  enabled: false,
  provider: 'builtin-markdown',
  topK: 5,
  autoLoad: true,
  autoSave: true,
  decayHalfLifeDays: 60,
  includeArchived: false,
};

const ALL_DEFAULT = {
  enabled: 'default',
  provider: 'default',
  topK: 'default',
  autoLoad: 'default',
  autoSave: 'default',
  decayHalfLifeDays: 'default',
  includeArchived: 'default',
};

const FIELD_NAMES = [
  'autoLoad',
  'autoSave',
  'decayHalfLifeDays',
  'enabled',
  'includeArchived',
  'provider',
  'topK',
];

/** The JSON shape of a `MemoryConfigView` after a subprocess round-trip. */
interface SerializedView {
  effective: Record<string, unknown>;
  instanceEffective: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  sources: Record<string, string>;
}

interface WorkspaceSpec {
  /** Workspace folder name (also its id). */
  slug: string;
  /** Written as `defaults.memory`; omit to write no key at all. */
  memory?: unknown;
  /** Skip writing the workspace config.json entirely. */
  omitConfig?: boolean;
}

interface SetupOptions {
  /** Written to the config-root config.json as the `memory` key. */
  instance?: unknown;
  /** Skip writing the config-root config.json entirely. */
  omitRootConfig?: boolean;
  workspaces: WorkspaceSpec[];
}

function setupConfigDir(options: SetupOptions) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-mem-view-'));
  tempDirs.push(configDir);

  const roots: Record<string, string> = {};
  for (const spec of options.workspaces) {
    const root = join(configDir, 'workspaces', spec.slug);
    mkdirSync(root, { recursive: true });
    roots[spec.slug] = root;

    if (spec.omitConfig) continue;
    const defaults: Record<string, unknown> = {};
    if (spec.memory !== undefined) defaults.memory = spec.memory;
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify(
        {
          id: spec.slug,
          name: spec.slug,
          slug: spec.slug,
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
      workspaces: options.workspaces.map((spec) => ({
        id: spec.slug,
        name: spec.slug,
        rootPath: roots[spec.slug],
        createdAt: Date.now(),
      })),
      activeWorkspaceId: options.workspaces[0]?.slug ?? null,
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

  /** Absolute root for a slug declared in `options.workspaces`. */
  const root = (slug: string): string => {
    const path = roots[slug];
    if (!path) throw new Error(`test setup: no workspace named "${slug}"`);
    return path;
  };

  return { configDir, root };
}

/** Load the view for one or more workspace roots inside a fresh subprocess. */
function viewIn(configDir: string, ...workspaceRoots: string[]): SerializedView[] {
  const args = workspaceRoots.length > 0 ? workspaceRoots : [undefined as unknown as string];
  const calls = args
    .map((root) => `loadMemoryConfigView(${root === undefined ? '' : JSON.stringify(root)})`)
    .join(',');

  const run = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `import { loadMemoryConfigView } from '${MEMORY_MODULE}';` +
        `console.log(JSON.stringify([${calls}]))`,
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

  return JSON.parse(run.stdout.toString().trim());
}

/** `viewIn` for a single root, without the tuple-indexing ceremony. */
function oneViewIn(configDir: string, workspaceRoot?: string): SerializedView {
  const [view] = workspaceRoot ? viewIn(configDir, workspaceRoot) : viewIn(configDir);
  if (!view) throw new Error('subprocess returned no view');
  return view;
}

/** `viewIn` for exactly two roots. */
function twoViewsIn(
  configDir: string,
  first: string,
  second: string,
): [SerializedView, SerializedView] {
  const [a, b] = viewIn(configDir, first, second);
  if (!a || !b) throw new Error('subprocess returned fewer views than requested');
  return [a, b];
}

describe('loadMemoryConfigView: fresh install (SUV-0029)', () => {
  it('renders a usable, disabled view with no config files at all', () => {
    const { configDir, root } = setupConfigDir({
      omitRootConfig: true,
      workspaces: [{ slug: 'fresh', omitConfig: true }],
    });

    const view = oneViewIn(configDir, root('fresh'));

    expect(view.effective).toEqual(DISABLED);
    expect(view.instanceEffective).toEqual(DISABLED);
    expect(view.sources).toEqual(ALL_DEFAULT);
    // Absent, not an empty object: a workspace that has never been edited
    // stores no key at all.
    expect(view.overrides).toBeUndefined();
  });

  it('renders the same way when configs exist but carry no memory key', () => {
    const { configDir, root } = setupConfigDir({ workspaces: [{ slug: 'plain' }] });

    const view = oneViewIn(configDir, root('plain'));

    expect(view.effective).toEqual(DISABLED);
    expect(view.sources).toEqual(ALL_DEFAULT);
    expect(view.overrides).toBeUndefined();
  });

  it('shows the feature gated off out of the box', () => {
    const { configDir, root } = setupConfigDir({ workspaces: [{ slug: 'plain' }] });
    expect(oneViewIn(configDir, root('plain')).effective.enabled).toBe(false);
  });
});

describe('loadMemoryConfigView: provenance (SUV-0029)', () => {
  it('attributes each field to its layer and exposes the raw override', () => {
    const { configDir, root } = setupConfigDir({
      instance: { topK: 20, includeArchived: true },
      workspaces: [{ slug: 'ws', memory: { enabled: true, topK: 3 } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    expect(view.effective).toEqual({
      enabled: true,
      provider: 'builtin-markdown',
      topK: 3,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: 60,
      includeArchived: true,
    });
    expect(view.sources).toEqual({
      enabled: 'workspace',
      provider: 'default',
      topK: 'workspace',
      autoLoad: 'default',
      autoSave: 'default',
      decayHalfLifeDays: 'default',
      includeArchived: 'instance',
    });
    expect(view.overrides).toEqual({ enabled: true, topK: 3 });
  });

  it('reports what a cleared override would revert to', () => {
    // The workspace turns OFF something the instance turns on — the display
    // must be able to say "clearing this gives you enabled / headroom-mcp".
    const { configDir, root } = setupConfigDir({
      instance: { enabled: true, provider: 'headroom-mcp', decayHalfLifeDays: 90 },
      workspaces: [
        { slug: 'ws', memory: { enabled: false, provider: 'builtin-markdown' } },
      ],
    });

    const { effective, instanceEffective } = oneViewIn(configDir, root('ws'));

    expect(effective.enabled).toBe(false);
    expect(effective.provider).toBe('builtin-markdown');
    expect(instanceEffective.enabled).toBe(true);
    expect(instanceEffective.provider).toBe('headroom-mcp');
    // Unset fields agree between the two — nothing to revert.
    expect(effective.decayHalfLifeDays).toBe(instanceEffective.decayHalfLifeDays);
    expect(effective.topK).toBe(instanceEffective.topK);
  });

  it('keeps forward-compatible unknown keys in the raw override layer', () => {
    const { configDir, root } = setupConfigDir({
      workspaces: [{ slug: 'ws', memory: { enabled: true, futureKnob: 'x' } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    // Raw, so an editor writing this object back cannot drop a key a newer
    // build wrote — while the resolved half ignores it.
    expect(view.overrides).toEqual({ enabled: true, futureKnob: 'x' });
    expect(view.sources.enabled).toBe('workspace');
    expect(Object.keys(view.sources).sort()).toEqual(FIELD_NAMES);
  });

  it('still surfaces the raw override when the layer is rejected', () => {
    // A hand-edited provider typo disables the layer for resolution purposes,
    // but the editor must still see what is actually on disk — otherwise the
    // settings UI silently rewrites a file it never showed the user.
    const { configDir, root } = setupConfigDir({
      instance: { enabled: true },
      workspaces: [{ slug: 'ws', memory: { enabled: false, provider: 'faiss' } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    expect(view.overrides).toEqual({ enabled: false, provider: 'faiss' });
    // Resolution ignores the corrupt layer entirely: instance wins.
    expect(view.effective.enabled).toBe(true);
    expect(view.sources.enabled).toBe('instance');
    expect(view.sources.provider).toBe('default');
  });

  it('reports an out-of-range override as a default rather than a clamp', () => {
    const { configDir, root } = setupConfigDir({
      workspaces: [{ slug: 'ws', memory: { topK: 500 } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    expect(view.sources.topK).toBe('default');
    expect(view.effective.topK).toBe(5);
  });

  it('cannot attribute anything to a workspace when no workspace is given', () => {
    const { configDir } = setupConfigDir({
      instance: { enabled: true },
      workspaces: [{ slug: 'ws', memory: { topK: 3 } }],
    });

    const view = oneViewIn(configDir);

    expect(view.sources.enabled).toBe('instance');
    expect(view.sources.topK).toBe('default');
    expect(view.overrides).toBeUndefined();
  });
});

describe('loadMemoryConfigView: per-workspace isolation (SUV-0029)', () => {
  it('enabling memory in one workspace leaves the other disabled', () => {
    const { configDir, root } = setupConfigDir({
      // No instance layer: the only thing that can enable a workspace is its
      // own override.
      workspaces: [
        { slug: 'alpha', memory: { enabled: true, topK: 10 } },
        { slug: 'beta' },
      ],
    });

    const [alpha, beta] = twoViewsIn(configDir, root('alpha'), root('beta'));

    expect(alpha.effective.enabled).toBe(true);
    expect(alpha.sources.enabled).toBe('workspace');

    expect(beta.effective).toEqual(DISABLED);
    expect(beta.sources).toEqual(ALL_DEFAULT);
    expect(beta.overrides).toBeUndefined();
  });

  it('a shared instance base is inherited independently by each workspace', () => {
    const { configDir, root } = setupConfigDir({
      instance: { enabled: true, provider: 'headroom-mcp' },
      workspaces: [{ slug: 'alpha', memory: { enabled: false } }, { slug: 'beta' }],
    });

    const [alpha, beta] = twoViewsIn(configDir, root('alpha'), root('beta'));

    // Alpha opts out; beta rides the instance base. Same file, two answers.
    expect(alpha.effective.enabled).toBe(false);
    expect(alpha.sources.enabled).toBe('workspace');
    expect(beta.effective.enabled).toBe(true);
    expect(beta.sources.enabled).toBe('instance');

    // Provider is shared, and the opt-out does not change which engine either
    // workspace would use when turned back on.
    expect(alpha.effective.provider).toBe('headroom-mcp');
    expect(beta.effective.provider).toBe('headroom-mcp');
  });

  it('lets two workspaces select different providers off the same instance base', () => {
    const { configDir, root } = setupConfigDir({
      instance: { enabled: true },
      workspaces: [
        { slug: 'alpha', memory: { provider: 'headroom-mcp' } },
        { slug: 'beta', memory: { provider: 'builtin-markdown' } },
      ],
    });

    const [alpha, beta] = twoViewsIn(configDir, root('alpha'), root('beta'));

    expect(alpha.effective.provider).toBe('headroom-mcp');
    expect(beta.effective.provider).toBe('builtin-markdown');
    expect(alpha.sources.provider).toBe('workspace');
    expect(beta.sources.provider).toBe('workspace');
    expect(alpha.instanceEffective.provider).toBe('builtin-markdown');
  });
});
