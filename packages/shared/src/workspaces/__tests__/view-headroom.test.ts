/**
 * `loadHeadroomConfigView()` — the read side of the workspace settings surface
 * (fork: PLAN-040, SUV-0017).
 *
 * Everything the Headroom settings section displays comes from this one call:
 * the effective config, what each field would revert to if its override were
 * cleared, and which layer supplied each effective value. The UI derives none
 * of it, so these tests are the real coverage for "shows where the value came
 * from" and "clearing reverts to the instance value".
 *
 * Runs in a subprocess with `CRAFT_CONFIG_DIR` set, the idiom SUV-0016's
 * `storage-headroom.test.ts` established — `config/paths.ts` freezes
 * CONFIG_DIR at module-eval, so the env var has to be claimed before any
 * import (LEARNING-056).
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

const HEADROOM_MODULE = pathToFileURL(join(import.meta.dir, '..', 'headroom.ts')).href;

const DISABLED = {
  enabled: false,
  compressionEngines: [],
  verbosity: 'balanced',
  exposeStats: false,
};

const ALL_DEFAULT = {
  enabled: 'default',
  compressionEngines: 'default',
  verbosity: 'default',
  exposeStats: 'default',
};

/** The JSON shape of a `HeadroomConfigView` after a subprocess round-trip. */
interface SerializedView {
  effective: Record<string, unknown>;
  instanceEffective: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  sources: Record<string, string>;
}

interface WorkspaceSpec {
  /** Workspace folder name (also its id). */
  slug: string;
  /** Written as `defaults.headroom`; omit to write no key at all. */
  headroom?: unknown;
  /** Skip writing the workspace config.json entirely. */
  omitConfig?: boolean;
}

interface SetupOptions {
  /** Written to the config-root config.json as the `headroom` key. */
  instance?: unknown;
  /** Skip writing the config-root config.json entirely. */
  omitRootConfig?: boolean;
  workspaces: WorkspaceSpec[];
}

function setupConfigDir(options: SetupOptions) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-hr-view-'));
  tempDirs.push(configDir);

  const roots: Record<string, string> = {};
  for (const spec of options.workspaces) {
    const root = join(configDir, 'workspaces', spec.slug);
    mkdirSync(root, { recursive: true });
    roots[spec.slug] = root;

    if (spec.omitConfig) continue;
    const defaults: Record<string, unknown> = {};
    if (spec.headroom !== undefined) defaults.headroom = spec.headroom;
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
    .map((root) => `loadHeadroomConfigView(${root === undefined ? '' : JSON.stringify(root)})`)
    .join(',');

  const run = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `import { loadHeadroomConfigView } from '${HEADROOM_MODULE}';` +
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

describe('loadHeadroomConfigView: fresh install (SUV-0017)', () => {
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

  it('renders the same way when configs exist but carry no headroom key', () => {
    const { configDir, root } = setupConfigDir({ workspaces: [{ slug: 'plain' }] });

    const view = oneViewIn(configDir, root('plain'));

    expect(view.effective).toEqual(DISABLED);
    expect(view.sources).toEqual(ALL_DEFAULT);
    expect(view.overrides).toBeUndefined();
  });
});

describe('loadHeadroomConfigView: provenance (SUV-0017)', () => {
  it('attributes each field to its layer and exposes the raw override', () => {
    const { configDir, root } = setupConfigDir({
      instance: { verbosity: 'verbose', exposeStats: true },
      workspaces: [{ slug: 'ws', headroom: { enabled: true, verbosity: 'terse' } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    expect(view.effective).toEqual({
      enabled: true,
      compressionEngines: [],
      verbosity: 'terse',
      exposeStats: true,
    });
    expect(view.sources).toEqual({
      enabled: 'workspace',
      compressionEngines: 'default',
      verbosity: 'workspace',
      exposeStats: 'instance',
    });
    expect(view.overrides).toEqual({ enabled: true, verbosity: 'terse' });
  });

  it('reports what a cleared override would revert to', () => {
    // The workspace turns OFF something the instance turns on — the display
    // must be able to say "clearing this gives you verbose / enabled".
    const { configDir, root } = setupConfigDir({
      instance: { enabled: true, verbosity: 'verbose' },
      workspaces: [{ slug: 'ws', headroom: { enabled: false, verbosity: 'terse' } }],
    });

    const { effective, instanceEffective } = oneViewIn(configDir, root('ws'));

    expect(effective.enabled).toBe(false);
    expect(effective.verbosity).toBe('terse');
    expect(instanceEffective.enabled).toBe(true);
    expect(instanceEffective.verbosity).toBe('verbose');
    // Unset fields agree between the two — nothing to revert.
    expect(effective.exposeStats).toBe(instanceEffective.exposeStats);
  });

  it('keeps forward-compatible unknown keys in the raw override layer', () => {
    const { configDir, root } = setupConfigDir({
      workspaces: [{ slug: 'ws', headroom: { enabled: true, futureKnob: 'x' } }],
    });

    const view = oneViewIn(configDir, root('ws'));

    // Raw, so an editor writing this object back cannot drop a key a newer
    // build wrote — while the resolved half ignores it.
    expect(view.overrides).toEqual({ enabled: true, futureKnob: 'x' });
    expect(view.sources.enabled).toBe('workspace');
    expect(Object.keys(view.sources).sort()).toEqual([
      'compressionEngines',
      'enabled',
      'exposeStats',
      'verbosity',
    ]);
  });

  it('cannot attribute anything to a workspace when no workspace is given', () => {
    const { configDir } = setupConfigDir({
      instance: { enabled: true },
      workspaces: [{ slug: 'ws', headroom: { verbosity: 'terse' } }],
    });

    const view = oneViewIn(configDir);

    expect(view.sources.enabled).toBe('instance');
    expect(view.sources.verbosity).toBe('default');
    expect(view.overrides).toBeUndefined();
  });
});

describe('loadHeadroomConfigView: per-workspace isolation (SUV-0017)', () => {
  it('enabling Headroom in one workspace leaves the other disabled', () => {
    const { configDir, root } = setupConfigDir({
      // No instance layer: the only thing that can enable a workspace is its
      // own override.
      workspaces: [
        { slug: 'alpha', headroom: { enabled: true, verbosity: 'terse' } },
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
      instance: { enabled: true, verbosity: 'balanced' },
      workspaces: [
        { slug: 'alpha', headroom: { enabled: false } },
        { slug: 'beta' },
      ],
    });

    const [alpha, beta] = twoViewsIn(configDir, root('alpha'), root('beta'));

    // Alpha opts out; beta rides the instance base. Same file, two answers.
    expect(alpha.effective.enabled).toBe(false);
    expect(alpha.sources.enabled).toBe('workspace');
    expect(beta.effective.enabled).toBe(true);
    expect(beta.sources.enabled).toBe('instance');
  });
});
