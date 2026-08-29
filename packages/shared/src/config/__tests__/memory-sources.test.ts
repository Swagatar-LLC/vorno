/**
 * Per-field provenance for the memory resolver (fork: PLAN-040, SUV-0029).
 *
 * The settings UI labels each field "workspace override" or "instance
 * default". That label is only trustworthy if it is derived from the same
 * validation and the same precedence the resolver itself uses — so the
 * central property here is agreement: for any pair of layers, the reported
 * source must name the layer whose value `resolveMemoryConfig` actually
 * returned.
 *
 * The subject lives in `@craft-agent/core`; the test lives here for the same
 * reason the Headroom equivalent does — `packages/core` has no test runner
 * wired up and CI's `test:shared` job is what gates the PR.
 */
import { describe, expect, it } from 'bun:test';
import {
  MEMORY_CONFIG_DEFAULTS,
  MEMORY_CONFIG_FIELDS,
  resolveMemoryConfig,
  resolveMemoryConfigSources,
} from '@craft-agent/core/types';
import type { MemoryConfigSources } from '@craft-agent/core/types';

const ALL_DEFAULT: MemoryConfigSources = {
  enabled: 'default',
  provider: 'default',
  topK: 'default',
  autoLoad: 'default',
  autoSave: 'default',
  decayHalfLifeDays: 'default',
  includeArchived: 'default',
};

describe('MEMORY_CONFIG_FIELDS', () => {
  it('lists exactly the fields of a resolved config', () => {
    const resolved = resolveMemoryConfig();
    expect([...MEMORY_CONFIG_FIELDS].sort()).toEqual(
      Object.keys(resolved).sort() as (keyof typeof resolved)[],
    );
  });
});

describe('resolveMemoryConfigSources (SUV-0029)', () => {
  it('reports every field as a default when nothing is stored', () => {
    expect(resolveMemoryConfigSources()).toEqual(ALL_DEFAULT);
  });

  it('attributes each field to the layer that supplied it', () => {
    const sources = resolveMemoryConfigSources(
      { enabled: true, topK: 20, decayHalfLifeDays: 90 },
      { enabled: false, provider: 'headroom-mcp', topK: 5 },
    );

    expect(sources).toEqual({
      enabled: 'workspace', // workspace wins even setting it back to false
      provider: 'workspace',
      topK: 'workspace',
      autoLoad: 'default',
      autoSave: 'default',
      decayHalfLifeDays: 'instance',
      includeArchived: 'default',
    });
  });

  it('treats an explicit null as unset, not as a workspace value', () => {
    const sources = resolveMemoryConfigSources(
      { includeArchived: true },
      { includeArchived: null },
    );
    expect(sources.includeArchived).toBe('instance');
  });

  it('treats a layer rejected by the validator as absent', () => {
    // A known field with an unknown provider poisons the whole layer.
    const sources = resolveMemoryConfigSources({ enabled: true }, { provider: 'weaviate' });
    expect(sources).toEqual({ ...ALL_DEFAULT, enabled: 'instance' });
  });

  it('treats a layer with an out-of-range number as absent', () => {
    // Rejection, not clamping — so the field reads "default", never
    // "workspace" with a value pinned to the bound.
    const sources = resolveMemoryConfigSources({ topK: 10 }, { topK: 500, autoSave: false });
    expect(sources.topK).toBe('instance');
    expect(sources.autoSave).toBe('default');
    expect(resolveMemoryConfig({ topK: 10 }, { topK: 500, autoSave: false }).topK).toBe(10);
  });

  it('attributes an in-range fractional half-life to its layer', () => {
    // The counterpart to the rejection case: a non-integer half-life is legal,
    // so it must be attributed like any other accepted value.
    const sources = resolveMemoryConfigSources(undefined, { decayHalfLifeDays: 2.5 });
    expect(sources.decayHalfLifeDays).toBe('workspace');
  });

  it('ignores unknown keys without attributing them', () => {
    const sources = resolveMemoryConfigSources(undefined, {
      enabled: true,
      futureKnob: 42,
    });
    expect(sources.enabled).toBe('workspace');
    expect(Object.keys(sources).sort()).toEqual([...MEMORY_CONFIG_FIELDS].sort());
  });

  it('agrees with the resolver about where every value came from', () => {
    const layerPairs: Array<[unknown, unknown]> = [
      [undefined, undefined],
      [{ enabled: true }, undefined],
      [undefined, { enabled: true }],
      [{ topK: 3, includeArchived: true }, { topK: 9 }],
      [{ provider: 'builtin-markdown' }, { provider: 'headroom-mcp' }],
      [{ autoLoad: false, autoSave: false }, { autoLoad: true }],
      [{ decayHalfLifeDays: 30 }, { decayHalfLifeDays: 1.5 }],
      [{ enabled: true }, 'not-an-object'],
      [{ enabled: 'yes' }, { includeArchived: true }],
      [{ topK: 12 }, { topK: 0 }],
      [{ provider: 'headroom-mcp' }, { provider: 'nope' }],
    ];

    for (const [instance, workspace] of layerPairs) {
      const effective = resolveMemoryConfig(instance, workspace);
      const sources = resolveMemoryConfigSources(instance, workspace);
      const instanceOnly = resolveMemoryConfig(instance, undefined);

      for (const field of MEMORY_CONFIG_FIELDS) {
        if (sources[field] === 'default') {
          expect(effective[field]).toEqual(MEMORY_CONFIG_DEFAULTS[field]);
        }
        if (sources[field] === 'instance') {
          // Nothing above the instance layer touched it, so clearing the
          // workspace layer must be a no-op for this field.
          expect(effective[field]).toEqual(instanceOnly[field]);
        }
      }
    }
  });
});
