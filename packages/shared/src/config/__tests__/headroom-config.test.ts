/**
 * Headroom config types + resolver (fork: PLAN-040, SUV-0016).
 *
 * The subject lives in `@craft-agent/core` (pure, dependency-free), but the
 * tests live here because `packages/core` has no test runner wired up and CI's
 * `test:shared` job is what actually gates the PR.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEADROOM_CONFIG_DEFAULTS,
  resolveHeadroomConfig,
  sanitizeHeadroomConfigLayer,
} from '@craft-agent/core/types';
import type { HeadroomConfig, HeadroomConfigOverrides } from '@craft-agent/core/types';

const HEADROOM_SOURCE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'core',
  'src',
  'types',
  'headroom.ts',
);

describe('headroom config types (SUV-0016)', () => {
  it('round-trips a fully-populated config through JSON without loss', () => {
    const config: HeadroomConfig = {
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    };

    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  it('round-trips the resolved default config through JSON without loss', () => {
    const resolved = resolveHeadroomConfig();
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });

  it('imports nothing from Electron or node filesystem modules', () => {
    const source = readFileSync(HEADROOM_SOURCE, 'utf-8');

    // Strip block and line comments so the doc comment's prose (which names
    // these modules to say it does NOT use them) can't produce a false red.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bfrom\s+['"]/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    for (const forbidden of ['electron', 'node:fs', 'node:path', "'fs'", "'path'"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe('instance rollout defaults (SUV-0025)', () => {
  const REPORT = join(
    import.meta.dir,
    '..', '..', '..', '..', '..',
    'roadmap', 'evidence', 'PLAN-040', 'headroom-benchmark-report.md',
  );

  it('is off in every field, as the benchmark concluded', () => {
    // Not a restatement of SUV-0016's provisional default. The benchmark
    // (2026-08-27, 240 compression calls over real workloads) found the pinned
    // proxy issues no retrieval handles at all, which makes session compression
    // inert and Conductor compression irreversible. Flipping any of these four
    // has to argue with that report — so this test names it.
    expect(HEADROOM_CONFIG_DEFAULTS).toEqual({
      enabled: false,
      compressionEngines: [],
      verbosity: 'balanced',
      exposeStats: false,
    });
  });

  it('cites a benchmark report that exists and records the decision', () => {
    // A default whose rationale points at a missing file is a default with no
    // rationale. The report is the evidence half of this SUV; if it is deleted
    // or renamed, the claim in `headroom.ts` becomes a dangling reference and
    // this test is what notices.
    const report = readFileSync(REPORT, 'utf8');
    expect(report).toContain('suv: SUV-0025');
    expect(report).toContain('Headroom stays off by default');

    const source = readFileSync(HEADROOM_SOURCE, 'utf8');
    expect(source).toContain('headroom-benchmark-report.md');
  });
});

describe('resolveHeadroomConfig precedence (SUV-0016)', () => {
  it('resolves to disabled when no config exists at either level', () => {
    expect(resolveHeadroomConfig(undefined, undefined)).toEqual({
      enabled: false,
      compressionEngines: [],
      verbosity: 'balanced',
      exposeStats: false,
    });
    // Same result for the no-argument call a fresh install produces.
    expect(resolveHeadroomConfig()).toEqual({ ...HEADROOM_CONFIG_DEFAULTS });
  });

  it('uses the instance base when only the instance layer is set', () => {
    const instance: HeadroomConfigOverrides = {
      enabled: true,
      compressionEngines: ['summarize'],
      verbosity: 'terse',
      exposeStats: true,
    };

    expect(resolveHeadroomConfig(instance, undefined)).toEqual({
      enabled: true,
      compressionEngines: ['summarize'],
      verbosity: 'terse',
      exposeStats: true,
    });
  });

  it('uses the workspace layer when only the workspace layer is set', () => {
    const workspace: HeadroomConfigOverrides = {
      enabled: true,
      verbosity: 'verbose',
    };

    expect(resolveHeadroomConfig(undefined, workspace)).toEqual({
      enabled: true,
      // unset here and unset at instance level → disabled default
      compressionEngines: [],
      verbosity: 'verbose',
      exposeStats: false,
    });
  });

  it('lets the workspace override the instance field-by-field', () => {
    const instance: HeadroomConfigOverrides = {
      enabled: true,
      compressionEngines: ['summarize', 'trim'],
      verbosity: 'terse',
      exposeStats: true,
    };
    const workspace: HeadroomConfigOverrides = {
      // overrides two fields, inherits the other two
      verbosity: 'verbose',
      exposeStats: false,
    };

    expect(resolveHeadroomConfig(instance, workspace)).toEqual({
      enabled: true, // inherited
      compressionEngines: ['summarize', 'trim'], // inherited
      verbosity: 'verbose', // overridden
      exposeStats: false, // overridden, and `false` is a real value not "unset"
    });
  });

  it('treats a workspace field set to null/undefined as unset, not as a value', () => {
    const instance: HeadroomConfigOverrides = { enabled: true, verbosity: 'terse' };
    const workspace = { enabled: null, verbosity: undefined };

    const resolved = resolveHeadroomConfig(instance, workspace);
    expect(resolved.enabled).toBe(true);
    expect(resolved.verbosity).toBe('terse');
  });

  it('lets a workspace explicitly disable an instance-enabled integration', () => {
    const resolved = resolveHeadroomConfig({ enabled: true }, { enabled: false });
    expect(resolved.enabled).toBe(false);
  });

  it('returns a fresh array each call so callers cannot mutate the stored layer', () => {
    const instance: HeadroomConfigOverrides = { compressionEngines: ['summarize'] };
    const a = resolveHeadroomConfig(instance);
    a.compressionEngines.push('mutated');

    expect(instance.compressionEngines).toEqual(['summarize']);
    expect(resolveHeadroomConfig(instance).compressionEngines).toEqual(['summarize']);
  });
});

describe('malformed headroom config (SUV-0016)', () => {
  const disabled = { ...HEADROOM_CONFIG_DEFAULTS };

  it('resolves malformed layers to disabled defaults instead of throwing', () => {
    // Real-world-shaped garbage: wrong types on every known field, plus keys
    // that do not exist, at both layers.
    const instance = {
      enabled: 'yes',
      compressionEngines: 'summarize',
      verbosity: 42,
      exposeStats: { on: true },
      unknownKnob: 'ignore me',
    };
    const workspace = {
      enabled: 1,
      verbosity: 'chatty',
      somethingFromAFutureVersion: { nested: true },
    };

    expect(() => resolveHeadroomConfig(instance, workspace)).not.toThrow();
    expect(resolveHeadroomConfig(instance, workspace)).toEqual(disabled);
  });

  it.each([
    ['a JSON string', '{"enabled":true}'],
    ['a number', 7],
    ['an array', [{ enabled: true }]],
    ['null', null],
    ['a boolean', true],
  ])('resolves to disabled when a layer is %s', (_label, layer) => {
    expect(() => resolveHeadroomConfig(layer, layer)).not.toThrow();
    expect(resolveHeadroomConfig(layer, layer)).toEqual(disabled);
  });

  it('rejects a corrupt layer wholesale rather than half-trusting it', () => {
    // `enabled` is valid, `verbosity` is not. Fail-safe: the layer is dropped,
    // so `enabled: true` does NOT survive.
    const resolved = resolveHeadroomConfig({ enabled: true, verbosity: 'shouty' });
    expect(resolved).toEqual(disabled);
  });

  it('falls back to the other layer when only one layer is corrupt', () => {
    const resolved = resolveHeadroomConfig({ enabled: true, verbosity: 'terse' }, 'garbage');
    expect(resolved.enabled).toBe(true);
    expect(resolved.verbosity).toBe('terse');
  });

  it('ignores unknown keys without disabling the feature (forward compat)', () => {
    const resolved = resolveHeadroomConfig({
      enabled: true,
      knobFromANewerBuild: 'whatever',
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved).not.toHaveProperty('knobFromANewerBuild');
  });

  it('rejects an engine list containing non-strings', () => {
    expect(sanitizeHeadroomConfigLayer({ compressionEngines: ['ok', 3] })).toBeNull();
    expect(sanitizeHeadroomConfigLayer({ compressionEngines: ['ok'] })).toEqual({
      compressionEngines: ['ok'],
    });
  });

  it('accepts an empty object as a valid, entirely-inheriting layer', () => {
    expect(sanitizeHeadroomConfigLayer({})).toEqual({});
  });
});
