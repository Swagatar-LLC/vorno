/**
 * Config → adapter-options mapping, and the "one construction path" invariant
 * (fork: PLAN-040 / SUV-0018).
 *
 * The end-to-end wiring (workspace `config.json` → constructed session) is
 * covered in `agent/__tests__/base-agent-headroom.test.ts`. What is pinned here
 * is the narrow, reviewable part: exactly which resolved fields cross into the
 * boundary, and the fact that nothing outside the boundary module builds an
 * adapter for itself.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { HEADROOM_CONFIG_DEFAULTS } from '@craft-agent/core/types';
import type { HeadroomConfig } from '@craft-agent/core/types';
import {
  createSessionHeadroomAdapter,
  headroomAdapterOptionsFor,
} from '../session-adapter.ts';
import type { HeadroomSdkModule } from '../sdk-adapter.ts';

/**
 * Held in a variable rather than written inline: a literal specifier makes
 * `tsc` resolve it at compile time and fail with TS2307, which would break the
 * typecheck gate over a module whose whole purpose is to be missing. Same
 * reasoning (and same constant) as `adapter-fallback.test.ts`.
 */
const ABSENT_PACKAGE = 'headroom-ai-not-installed-in-this-repo';
const loadAbsentSdk: () => Promise<HeadroomSdkModule> = () =>
  import(ABSENT_PACKAGE) as Promise<HeadroomSdkModule>;

const ENABLED: HeadroomConfig = {
  enabled: true,
  compressionEngines: ['summarize'],
  verbosity: 'terse',
  exposeStats: true,
};

describe('headroomAdapterOptionsFor (SUV-0018)', () => {
  it('carries the resolved master switch through, both ways', () => {
    expect(headroomAdapterOptionsFor(ENABLED).enabled).toBe(true);
    expect(headroomAdapterOptionsFor(HEADROOM_CONFIG_DEFAULTS).enabled).toBe(false);
  });

  it('passes the session model as the adapter default model', () => {
    expect(headroomAdapterOptionsFor(ENABLED, 'claude-opus-5').model).toBe(
      'claude-opus-5',
    );
  });

  it('omits the model key entirely when the session has none', () => {
    // Not `model: undefined`: the boundary spreads options conditionally, and an
    // explicit undefined is a different thing from an absent key to any future
    // reader of this object.
    expect('model' in headroomAdapterOptionsFor(ENABLED)).toBe(false);
  });

  it('invents no endpoint or credential', () => {
    // SUV-0015 deliberately pins `baseUrl` inside the boundary and refuses env
    // as a channel; SUV-0016's config supplies neither. Synthesizing one here
    // would put a service address in a layer that has no way to have been told
    // about it. When a configured source exists, it gets its own SUV.
    const options = headroomAdapterOptionsFor(ENABLED, 'claude-opus-5');
    expect(options.baseUrl).toBeUndefined();
    expect(options.apiKey).toBeUndefined();
    expect(options.timeoutMs).toBeUndefined();
  });

  it('does not smuggle config fields the adapter has no option for', () => {
    // `compressionEngines`, `verbosity` and `exposeStats` are resolved and read
    // by the session, but `HeadroomAdapterOptions` has nowhere to put them.
    // Passing them as extra keys would fake a contract the SDK never agreed to.
    expect(Object.keys(headroomAdapterOptionsFor(ENABLED, 'm')).sort()).toEqual([
      'enabled',
      'model',
    ]);
  });
});

describe('createSessionHeadroomAdapter (SUV-0018)', () => {
  it('warns exactly once when an enabled workspace cannot load the SDK', async () => {
    const warnings: string[] = [];
    const adapter = await createSessionHeadroomAdapter(
      ENABLED,
      { onWarn: (message) => warnings.push(message) },
      { loadSdk: loadAbsentSdk },
    );

    expect(adapter.kind).toBe('noop');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Headroom');
  });

  it('is silent when Headroom is simply off', async () => {
    const warnings: string[] = [];
    const adapter = await createSessionHeadroomAdapter(HEADROOM_CONFIG_DEFAULTS, {
      onWarn: (message) => warnings.push(message),
    });

    expect(adapter.kind).toBe('noop');
    expect(warnings).toEqual([]);
  });

  it('is silent when the SDK loads and the real adapter is built', async () => {
    const warnings: string[] = [];
    const adapter = await createSessionHeadroomAdapter(
      ENABLED,
      { onWarn: (message) => warnings.push(message) },
      {
        loadSdk: async () =>
          ({
            HeadroomClient: class {
              async compress() {
                return { compressed: false };
              }
              async retrieve() {
                return null;
              }
              async getStats() {
                return null;
              }
            },
          }) as unknown as HeadroomSdkModule,
      },
    );

    expect(adapter.kind).toBe('sdk');
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The factory is the only construction path
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage']);
const SOURCE_EXTS = ['.ts', '.tsx'];

/** Files that may name an implementation directly: the boundary and its tests. */
const CONSTRUCTION_OWNERS = ['packages/shared/src/headroom/'];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) collectSourceFiles(full, acc);
    else if (SOURCE_EXTS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }
  return acc;
}

describe('the boundary factory is the sole construction path (SUV-0018)', () => {
  it('finds no call site building an adapter implementation for itself', () => {
    // Sibling of the SDK-import gate in `scripts/check-headroom-boundary.ts`,
    // one rung up: that one stops a second file talking to `headroom-ai`, this
    // one stops a call site deciding for itself which adapter a session gets —
    // which is the decision SUV-0018 moves into resolved configuration.
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..');
    const direct = /\bnew\s+SdkHeadroomAdapter\b|\bcreateNoopHeadroomAdapter\s*\(/;

    const violations = ['apps', 'packages']
      .flatMap((root) => collectSourceFiles(join(repoRoot, root)))
      .map((file) => relative(repoRoot, file).split(sep).join('/'))
      .filter((rel) => !CONSTRUCTION_OWNERS.some((owner) => rel.startsWith(owner)))
      .filter((rel) => direct.test(readFileSync(join(repoRoot, rel), 'utf8')));

    expect(violations).toEqual([]);
  });
});
