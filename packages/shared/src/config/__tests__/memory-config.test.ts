/**
 * Memory config types + resolver (fork: PLAN-040, SUV-0029; ADR-0031).
 *
 * The subject lives in `@craft-agent/core` (pure, dependency-free), but the
 * tests live here because `packages/core` has no test runner wired up and CI's
 * `test:shared` job is what actually gates the PR — the same reason
 * `headroom-config.test.ts` sits beside this file.
 *
 * `memory.ts` is deliberately a near-copy of `headroom.ts`, so this suite is
 * deliberately a near-copy of that one: two config schemas in the same product
 * that disagree about what a corrupt file means is a support ticket waiting to
 * happen, and the only way to keep them in agreement is to hold them to the
 * same tests.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMORY_CONFIG_DEFAULTS,
  MEMORY_CONFIG_FIELDS,
  MEMORY_HALF_LIFE_MAX_DAYS,
  MEMORY_HALF_LIFE_MIN_DAYS,
  MEMORY_PROVIDER_CHOICES,
  MEMORY_TOP_K_MAX,
  MEMORY_TOP_K_MIN,
  resolveMemoryConfig,
  sanitizeMemoryConfigLayer,
} from '@craft-agent/core/types';
import type { MemoryConfig, MemoryConfigOverrides } from '@craft-agent/core/types';

const MEMORY_SOURCE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'core',
  'src',
  'types',
  'memory.ts',
);

describe('memory config types (SUV-0029)', () => {
  it('round-trips a fully-populated config through JSON without loss', () => {
    const config: MemoryConfig = {
      enabled: true,
      provider: 'headroom-mcp',
      topK: 12,
      autoLoad: false,
      autoSave: true,
      decayHalfLifeDays: 30,
      includeArchived: true,
    };

    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  it('round-trips the resolved default config through JSON without loss', () => {
    const resolved = resolveMemoryConfig();
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });

  it('imports nothing from Electron or node filesystem modules', () => {
    const source = readFileSync(MEMORY_SOURCE, 'utf-8');

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

describe('MEMORY_CONFIG_FIELDS (SUV-0029)', () => {
  it('lists exactly the keys of MemoryConfig', () => {
    // Structural, not a restatement: the settings UI renders this list rather
    // than hardcoding its own, so a field added to the interface without being
    // added here would be invisible in the editor. `Record<MemoryConfigField,
    // true>` makes the omission a type error too, and the runtime comparison
    // catches the reverse (a stale entry for a field that no longer exists).
    const everyField: Record<keyof MemoryConfig, true> = {
      enabled: true,
      provider: true,
      topK: true,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: true,
      includeArchived: true,
    };

    expect([...MEMORY_CONFIG_FIELDS].sort()).toEqual(Object.keys(everyField).sort() as never);
    expect([...MEMORY_CONFIG_FIELDS].sort()).toEqual(
      Object.keys(resolveMemoryConfig()).sort() as never,
    );
  });

  it('has no duplicate entries', () => {
    expect(new Set(MEMORY_CONFIG_FIELDS).size).toBe(MEMORY_CONFIG_FIELDS.length);
  });
});

describe('memory rollout defaults (SUV-0029)', () => {
  it('ships gated: enabled is false', () => {
    // The load-bearing half of the rollout posture (PLAN-040 §I0 / ADR-0031):
    // Vorno must be fully functional with memory off, and the feature must be
    // turned on deliberately per workspace. Flipping this is an ADR-level
    // change, not a default tweak.
    expect(MEMORY_CONFIG_DEFAULTS.enabled).toBe(false);
  });

  it('pins the whole default object', () => {
    expect(MEMORY_CONFIG_DEFAULTS).toEqual({
      enabled: false,
      provider: 'builtin-markdown',
      topK: 5,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: 60,
      includeArchived: false,
    });
  });

  it('selects the provider with zero provisioning burden underneath the gate', () => {
    // ADR-0031 commitment 4: flipping `enabled` must yield working memory, not
    // a setup errand. Only `builtin-markdown` needs no Python, model fetch,
    // provider key, or egress.
    expect(MEMORY_CONFIG_DEFAULTS.provider).toBe('builtin-markdown');
    expect(MEMORY_PROVIDER_CHOICES).toContain(MEMORY_CONFIG_DEFAULTS.provider);
  });

  it('defaults archived memories out of reach', () => {
    // "An archive that still loads is not an archive, it is a rename."
    expect(MEMORY_CONFIG_DEFAULTS.includeArchived).toBe(false);
  });

  it('keeps both defaults inside their declared bounds', () => {
    expect(MEMORY_CONFIG_DEFAULTS.topK).toBeGreaterThanOrEqual(MEMORY_TOP_K_MIN);
    expect(MEMORY_CONFIG_DEFAULTS.topK).toBeLessThanOrEqual(MEMORY_TOP_K_MAX);
    expect(MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays).toBeGreaterThanOrEqual(
      MEMORY_HALF_LIFE_MIN_DAYS,
    );
    expect(MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays).toBeLessThanOrEqual(
      MEMORY_HALF_LIFE_MAX_DAYS,
    );
  });
});

describe('resolveMemoryConfig precedence (SUV-0029)', () => {
  it('resolves to disabled when no config exists at either level', () => {
    expect(resolveMemoryConfig(undefined, undefined)).toEqual({
      enabled: false,
      provider: 'builtin-markdown',
      topK: 5,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: 60,
      includeArchived: false,
    });
    // Same result for the no-argument call a fresh install produces.
    expect(resolveMemoryConfig()).toEqual({ ...MEMORY_CONFIG_DEFAULTS });
  });

  it('uses the instance base when only the instance layer is set', () => {
    const instance: MemoryConfigOverrides = {
      enabled: true,
      provider: 'headroom-mcp',
      topK: 20,
      autoLoad: false,
      autoSave: false,
      decayHalfLifeDays: 7,
      includeArchived: true,
    };

    expect(resolveMemoryConfig(instance, undefined)).toEqual({
      enabled: true,
      provider: 'headroom-mcp',
      topK: 20,
      autoLoad: false,
      autoSave: false,
      decayHalfLifeDays: 7,
      includeArchived: true,
    });
  });

  it('uses the workspace layer when only the workspace layer is set', () => {
    const workspace: MemoryConfigOverrides = {
      enabled: true,
      topK: 3,
    };

    expect(resolveMemoryConfig(undefined, workspace)).toEqual({
      enabled: true,
      // unset here and unset at instance level → defaults
      provider: 'builtin-markdown',
      topK: 3,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: 60,
      includeArchived: false,
    });
  });

  it('lets the workspace override the instance field-by-field', () => {
    const instance: MemoryConfigOverrides = {
      enabled: true,
      provider: 'headroom-mcp',
      topK: 20,
      autoLoad: true,
      autoSave: true,
      decayHalfLifeDays: 90,
      includeArchived: true,
    };
    const workspace: MemoryConfigOverrides = {
      // overrides three fields, inherits the rest
      provider: 'builtin-markdown',
      topK: 5,
      autoSave: false,
    };

    expect(resolveMemoryConfig(instance, workspace)).toEqual({
      enabled: true, // inherited
      provider: 'builtin-markdown', // overridden
      topK: 5, // overridden
      autoLoad: true, // inherited
      autoSave: false, // overridden, and `false` is a real value not "unset"
      decayHalfLifeDays: 90, // inherited
      includeArchived: true, // inherited
    });
  });

  it('treats a workspace field set to null/undefined as unset, not as a value', () => {
    const instance: MemoryConfigOverrides = { enabled: true, topK: 11 };
    const workspace = { enabled: null, topK: undefined };

    const resolved = resolveMemoryConfig(instance, workspace);
    expect(resolved.enabled).toBe(true);
    expect(resolved.topK).toBe(11);
  });

  it('lets a workspace explicitly disable an instance-enabled feature', () => {
    const resolved = resolveMemoryConfig({ enabled: true }, { enabled: false });
    expect(resolved.enabled).toBe(false);
  });

  it('lets a workspace turn autoLoad/autoSave off without touching the gate', () => {
    const resolved = resolveMemoryConfig(
      { enabled: true },
      { autoLoad: false, autoSave: false },
    );
    expect(resolved.enabled).toBe(true);
    expect(resolved.autoLoad).toBe(false);
    expect(resolved.autoSave).toBe(false);
  });

  it('returns a fresh object each call so callers cannot mutate the stored layer', () => {
    const instance: MemoryConfigOverrides = { topK: 9 };
    const a = resolveMemoryConfig(instance);
    a.topK = 999;

    expect(instance.topK).toBe(9);
    expect(resolveMemoryConfig(instance).topK).toBe(9);
  });
});

describe('memory provider selection (SUV-0029)', () => {
  it('accepts every declared provider choice', () => {
    for (const provider of MEMORY_PROVIDER_CHOICES) {
      expect(sanitizeMemoryConfigLayer({ provider })).toEqual({ provider });
      expect(resolveMemoryConfig({ provider }).provider).toBe(provider);
    }
  });

  it('declares exactly the two providers the seam ships with', () => {
    expect([...MEMORY_PROVIDER_CHOICES]).toEqual(['builtin-markdown', 'headroom-mcp']);
  });

  it.each([
    ['a typo of a real provider', 'builtin-markdow'],
    ['a provider that does not exist', 'sqlite-vector'],
    ['an empty string', ''],
    ['a differently-cased choice', 'Builtin-Markdown'],
  ])('rejects the WHOLE layer when provider is %s', (_label, provider) => {
    // Closed set on purpose: the registry is ours and in-tree, so a typo is a
    // rejected layer, not a silent fallthrough to a provider that isn't there.
    expect(sanitizeMemoryConfigLayer({ enabled: true, provider })).toBeNull();
    expect(resolveMemoryConfig({ enabled: true, provider })).toEqual({
      ...MEMORY_CONFIG_DEFAULTS,
    });
  });

  it('rejects the layer when provider is a non-string', () => {
    expect(sanitizeMemoryConfigLayer({ provider: 3 })).toBeNull();
    expect(sanitizeMemoryConfigLayer({ provider: ['builtin-markdown'] })).toBeNull();
    expect(sanitizeMemoryConfigLayer({ provider: { name: 'builtin-markdown' } })).toBeNull();
  });
});

describe('memory numeric bounds (SUV-0029)', () => {
  it('accepts topK at both inclusive bounds', () => {
    expect(sanitizeMemoryConfigLayer({ topK: MEMORY_TOP_K_MIN })).toEqual({ topK: 1 });
    expect(sanitizeMemoryConfigLayer({ topK: MEMORY_TOP_K_MAX })).toEqual({ topK: 50 });
  });

  it.each([
    ['below the minimum', 0],
    ['negative', -1],
    ['above the maximum', 51],
    ['absurdly large', 1_000_000],
  ])('rejects the whole layer when topK is %s', (_label, topK) => {
    expect(sanitizeMemoryConfigLayer({ enabled: true, topK })).toBeNull();
  });

  it('rejects the whole layer when topK is a non-integer', () => {
    // `topK` is a count of memories spliced into context; 2.5 of them is not a
    // thing, so the field is validated as an integer even in range.
    expect(sanitizeMemoryConfigLayer({ topK: 2.5 })).toBeNull();
    expect(sanitizeMemoryConfigLayer({ topK: 4.999 })).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '5'],
  ])('rejects the whole layer when topK is %s', (_label, topK) => {
    expect(sanitizeMemoryConfigLayer({ topK })).toBeNull();
  });

  it('accepts decayHalfLifeDays at both inclusive bounds', () => {
    expect(
      sanitizeMemoryConfigLayer({ decayHalfLifeDays: MEMORY_HALF_LIFE_MIN_DAYS }),
    ).toEqual({ decayHalfLifeDays: 1 });
    expect(
      sanitizeMemoryConfigLayer({ decayHalfLifeDays: MEMORY_HALF_LIFE_MAX_DAYS }),
    ).toEqual({ decayHalfLifeDays: 3650 });
  });

  it.each([
    ['below the minimum', 0],
    ['a fraction below the minimum', 0.5],
    ['negative', -60],
    ['above the maximum', 3651],
  ])('rejects the whole layer when decayHalfLifeDays is %s', (_label, decayHalfLifeDays) => {
    expect(sanitizeMemoryConfigLayer({ enabled: true, decayHalfLifeDays })).toBeNull();
  });

  it('accepts a non-integer decayHalfLifeDays that is in range', () => {
    // Documented as a number, not an integer — a half-life of 1.5 days is a
    // perfectly meaningful decay weight, unlike a fractional topK. This is the
    // one place the two numeric fields deliberately differ.
    expect(sanitizeMemoryConfigLayer({ decayHalfLifeDays: 1.5 })).toEqual({
      decayHalfLifeDays: 1.5,
    });
    expect(sanitizeMemoryConfigLayer({ decayHalfLifeDays: 3649.25 })).toEqual({
      decayHalfLifeDays: 3649.25,
    });
    expect(resolveMemoryConfig({ decayHalfLifeDays: 7.5 }).decayHalfLifeDays).toBe(7.5);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '60'],
    ['a boolean', true],
  ])('rejects the whole layer when decayHalfLifeDays is %s', (_label, decayHalfLifeDays) => {
    expect(sanitizeMemoryConfigLayer({ decayHalfLifeDays })).toBeNull();
  });

  it('rejects out-of-range numbers rather than clamping them', () => {
    // The distinction matters: clamping would make the stored file and the
    // effective value silently disagree, and the settings UI would show a
    // number the user never typed. So the effective value must be the DEFAULT,
    // not the nearest bound.
    expect(resolveMemoryConfig({ topK: 51 }).topK).toBe(MEMORY_CONFIG_DEFAULTS.topK);
    expect(resolveMemoryConfig({ topK: 51 }).topK).not.toBe(MEMORY_TOP_K_MAX);
    expect(resolveMemoryConfig({ topK: 0 }).topK).toBe(MEMORY_CONFIG_DEFAULTS.topK);
    expect(resolveMemoryConfig({ topK: 0 }).topK).not.toBe(MEMORY_TOP_K_MIN);

    expect(resolveMemoryConfig({ decayHalfLifeDays: 3651 }).decayHalfLifeDays).toBe(
      MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays,
    );
    expect(resolveMemoryConfig({ decayHalfLifeDays: 3651 }).decayHalfLifeDays).not.toBe(
      MEMORY_HALF_LIFE_MAX_DAYS,
    );
    expect(resolveMemoryConfig({ decayHalfLifeDays: 0 }).decayHalfLifeDays).toBe(
      MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays,
    );
    expect(resolveMemoryConfig({ decayHalfLifeDays: 0 }).decayHalfLifeDays).not.toBe(
      MEMORY_HALF_LIFE_MIN_DAYS,
    );
  });

  it('falls through to the instance layer when only the workspace is out of range', () => {
    const resolved = resolveMemoryConfig({ topK: 30 }, { topK: 99 });
    expect(resolved.topK).toBe(30);
  });
});

describe('malformed memory config (SUV-0029)', () => {
  const disabled = { ...MEMORY_CONFIG_DEFAULTS };

  it('resolves malformed layers to disabled defaults instead of throwing', () => {
    // Real-world-shaped garbage: wrong types on every known field, plus keys
    // that do not exist, at both layers.
    const instance = {
      enabled: 'yes',
      provider: 42,
      topK: 'five',
      autoLoad: { on: true },
      autoSave: [],
      decayHalfLifeDays: '60',
      includeArchived: 1,
      unknownKnob: 'ignore me',
    };
    const workspace = {
      enabled: 1,
      provider: 'chroma',
      somethingFromAFutureVersion: { nested: true },
    };

    expect(() => resolveMemoryConfig(instance, workspace)).not.toThrow();
    expect(resolveMemoryConfig(instance, workspace)).toEqual(disabled);
  });

  it.each([
    ['a JSON string', '{"enabled":true}'],
    ['a number', 7],
    ['an array', [{ enabled: true }]],
    ['null', null],
    ['a boolean', true],
  ])('resolves to disabled when a layer is %s', (_label, layer) => {
    expect(() => resolveMemoryConfig(layer, layer)).not.toThrow();
    expect(resolveMemoryConfig(layer, layer)).toEqual(disabled);
  });

  it('rejects a corrupt layer wholesale rather than half-trusting it', () => {
    // `enabled` is valid, `provider` is not. Fail-safe: the layer is dropped,
    // so `enabled: true` does NOT survive.
    const resolved = resolveMemoryConfig({ enabled: true, provider: 'pinecone' });
    expect(resolved).toEqual(disabled);
  });

  it('drops a valid enabled alongside an out-of-range number in the same layer', () => {
    // Same rule as above, exercised through the numeric validators: partially
    // trusting a file we know is corrupt is the subtler bug.
    expect(resolveMemoryConfig({ enabled: true, topK: 0 })).toEqual(disabled);
    expect(resolveMemoryConfig({ enabled: true, decayHalfLifeDays: 99999 })).toEqual(disabled);
  });

  it('falls back to the other layer when only one layer is corrupt', () => {
    const resolved = resolveMemoryConfig({ enabled: true, topK: 8 }, 'garbage');
    expect(resolved.enabled).toBe(true);
    expect(resolved.topK).toBe(8);
  });

  it('ignores unknown keys without disabling the feature (forward compat)', () => {
    const resolved = resolveMemoryConfig({
      enabled: true,
      knobFromANewerBuild: 'whatever',
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved).not.toHaveProperty('knobFromANewerBuild');
  });

  it.each(['enabled', 'autoLoad', 'autoSave', 'includeArchived'])(
    'rejects the layer when the boolean field %s is not a boolean',
    (field) => {
      expect(sanitizeMemoryConfigLayer({ [field]: 'true' })).toBeNull();
      expect(sanitizeMemoryConfigLayer({ [field]: 1 })).toBeNull();
      expect(sanitizeMemoryConfigLayer({ [field]: {} })).toBeNull();
    },
  );

  it('treats an explicitly null field as unset rather than rejecting the layer', () => {
    expect(sanitizeMemoryConfigLayer({ enabled: null, topK: 4 })).toEqual({ topK: 4 });
    expect(sanitizeMemoryConfigLayer({ provider: undefined, autoSave: false })).toEqual({
      autoSave: false,
    });
  });

  it('accepts an empty object as a valid, entirely-inheriting layer', () => {
    expect(sanitizeMemoryConfigLayer({})).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a number', 3],
    ['an array', []],
  ])('returns null for a layer that is %s', (_label, layer) => {
    expect(sanitizeMemoryConfigLayer(layer)).toBeNull();
  });
});
