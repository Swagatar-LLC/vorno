/**
 * Per-field provenance for the Headroom resolver (fork: PLAN-040, SUV-0017).
 *
 * The settings UI labels each field "workspace override" or "instance
 * default". That label is only trustworthy if it is derived from the same
 * validation and the same precedence the resolver itself uses — so the
 * central property here is agreement: for any pair of layers, the reported
 * source must name the layer whose value `resolveHeadroomConfig` actually
 * returned.
 *
 * The subject lives in `@craft-agent/core`; the test lives here for the same
 * reason SUV-0016's does — `packages/core` has no test runner wired up and
 * CI's `test:shared` job is what gates the PR.
 */
import { describe, expect, it } from 'bun:test';
import {
  HEADROOM_CONFIG_DEFAULTS,
  HEADROOM_CONFIG_FIELDS,
  resolveHeadroomConfig,
  resolveHeadroomConfigSources,
} from '@craft-agent/core/types';

describe('HEADROOM_CONFIG_FIELDS', () => {
  it('lists exactly the fields of a resolved config', () => {
    const resolved = resolveHeadroomConfig();
    expect([...HEADROOM_CONFIG_FIELDS].sort()).toEqual(
      Object.keys(resolved).sort() as (keyof typeof resolved)[],
    );
  });
});

describe('resolveHeadroomConfigSources (SUV-0017)', () => {
  it('reports every field as a default when nothing is stored', () => {
    expect(resolveHeadroomConfigSources()).toEqual({
      enabled: 'default',
      compressionEngines: 'default',
      verbosity: 'default',
      exposeStats: 'default',
    });
  });

  it('attributes each field to the layer that supplied it', () => {
    const sources = resolveHeadroomConfigSources(
      { enabled: true, verbosity: 'verbose' },
      { enabled: false, compressionEngines: ['trim'] },
    );

    expect(sources).toEqual({
      enabled: 'workspace', // workspace wins even setting it back to false
      compressionEngines: 'workspace',
      verbosity: 'instance',
      exposeStats: 'default',
    });
  });

  it('treats an explicit null as unset, not as a workspace value', () => {
    const sources = resolveHeadroomConfigSources(
      { exposeStats: true },
      { exposeStats: null },
    );
    expect(sources.exposeStats).toBe('instance');
  });

  it('treats a layer rejected by the validator as absent', () => {
    // A known field with the wrong type poisons the whole layer (SUV-0016).
    const sources = resolveHeadroomConfigSources(
      { enabled: true },
      { verbosity: 'shouty' },
    );
    expect(sources).toEqual({
      enabled: 'instance',
      compressionEngines: 'default',
      verbosity: 'default',
      exposeStats: 'default',
    });
  });

  it('ignores unknown keys without attributing them', () => {
    const sources = resolveHeadroomConfigSources(undefined, {
      enabled: true,
      futureKnob: 42,
    });
    expect(sources.enabled).toBe('workspace');
    expect(Object.keys(sources).sort()).toEqual([...HEADROOM_CONFIG_FIELDS].sort());
  });

  it('agrees with the resolver about where every value came from', () => {
    const layerPairs: Array<[unknown, unknown]> = [
      [undefined, undefined],
      [{ enabled: true }, undefined],
      [undefined, { enabled: true }],
      [{ verbosity: 'terse', exposeStats: true }, { verbosity: 'verbose' }],
      [{ compressionEngines: ['a'] }, { compressionEngines: [] }],
      [{ enabled: true }, 'not-an-object'],
      [{ enabled: 'yes' }, { exposeStats: true }],
    ];

    for (const [instance, workspace] of layerPairs) {
      const effective = resolveHeadroomConfig(instance, workspace);
      const sources = resolveHeadroomConfigSources(instance, workspace);
      const instanceOnly = resolveHeadroomConfig(instance, undefined);

      for (const field of HEADROOM_CONFIG_FIELDS) {
        if (sources[field] === 'default') {
          expect(effective[field]).toEqual(HEADROOM_CONFIG_DEFAULTS[field]);
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
