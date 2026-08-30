/**
 * The provider registry and the degrade matrix (fork: PLAN-040 / SUV-0029).
 *
 * These are the tests behind SUV-0029's first and last acceptance items:
 * "swapping the active provider is a config change that touches no call site,
 * asserted by a test that runs the same call path against both", and the
 * per-provider degrade matrix with its **three** states.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from '@craft-agent/core/types';

import { REGISTERED_MEMORY_PROVIDER_IDS, createMemoryProvider } from '../registry.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vorno-memory-registry-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const config = (overrides: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...MEMORY_CONFIG_DEFAULTS,
  enabled: true,
  ...overrides,
});

describe('the registry knows both providers', () => {
  it('registers exactly the providers the config schema offers', () => {
    // If these two lists drift, a user can select a provider that cannot be
    // built — a config value with no implementation behind it.
    expect([...REGISTERED_MEMORY_PROVIDER_IDS].sort()).toEqual([
      'builtin-markdown',
      'headroom-mcp',
    ]);
  });

  it('constructs each one and reports its own id', () => {
    expect(createMemoryProvider(config({ provider: 'builtin-markdown' }), { workspaceRootPath: workspace }).id).toBe(
      'builtin-markdown',
    );
    expect(createMemoryProvider(config({ provider: 'headroom-mcp' }), { workspaceRootPath: workspace }).id).toBe(
      'headroom-mcp',
    );
  });
});

describe('SUV-0029 acceptance: swapping providers is a config change, not a call-site change', () => {
  it('runs the identical call path against both providers', async () => {
    // The body of this loop is the "call site". It names no provider, branches
    // on nothing, and is byte-identical for both — which is the property under
    // test. The two providers give different *answers* (headroom-mcp is very
    // likely absent on a CI box), and that is fine: what must not differ is the
    // shape of the interaction or the caller's ability to complete it.
    for (const provider of ['builtin-markdown', 'headroom-mcp'] as const) {
      const memory = createMemoryProvider(config({ provider }), { workspaceRootPath: workspace });

      const saved = await memory.save({ facts: [{ content: 'A fact both providers are offered.' }] });
      const found = await memory.search({ query: 'fact offered' });
      const described = await memory.describe();

      // Same contract, whichever engine answered.
      expect(typeof saved.available).toBe('boolean');
      expect(typeof found.available).toBe('boolean');
      expect(described.providerId).toBe(provider);
      expect(['ready', 'unprovisioned', 'absent', 'disabled']).toContain(described.state);
      expect(Array.isArray(described.notes)).toBe(true);

      // Neither may throw, whatever state it is in.
      await memory.dispose?.();
    }
  });

  it('changing only the config field changes which engine answers', async () => {
    const builtin = createMemoryProvider(config({ provider: 'builtin-markdown' }), {
      workspaceRootPath: workspace,
    });
    const headroom = createMemoryProvider(config({ provider: 'headroom-mcp' }), {
      workspaceRootPath: workspace,
    });

    // Nothing but the config string differed between these two constructions.
    expect(builtin.id).not.toBe(headroom.id);
    expect((await builtin.describe()).search).toBe('lexical');
    expect((await headroom.describe()).search).toBe('semantic');
    await headroom.dispose?.();
  });
});

describe('SUV-0029 acceptance: the degrade matrix', () => {
  it('DISABLED — reports disabled, distinctly, and never throws', async () => {
    const memory = createMemoryProvider(config({ enabled: false }), { workspaceRootPath: workspace });
    const found = await memory.search({ query: 'anything' });
    const saved = await memory.save({ facts: [{ content: 'anything' }] });

    expect(found.available).toBe(false);
    expect(!found.available && found.reason).toBe('disabled');
    expect(!saved.available && saved.reason).toBe('disabled');
    expect((await memory.describe()).state).toBe('disabled');
  });

  it('NOT CONFIGURED — an unknown provider id is reported as such, not as absent', async () => {
    // An older build reading a newer workspace. Telling the user "absent" would
    // send them to install something; "not configured" sends them to settings.
    const memory = createMemoryProvider(
      config({ provider: 'some-future-engine' as MemoryConfig['provider'] }),
      { workspaceRootPath: workspace },
    );
    const found = await memory.search({ query: 'anything' });
    expect(!found.available && found.reason).toBe('not-configured');
  });

  it('NOT CONFIGURED — no workspace path means memory has nowhere to live', async () => {
    const memory = createMemoryProvider(config(), { workspaceRootPath: '' });
    const found = await memory.search({ query: 'anything' });
    expect(!found.available && found.reason).toBe('not-configured');
  });

  it('ABSENT — a provider whose prerequisites are missing reports absent, not error', async () => {
    // Point the Headroom provider at an interpreter that does not exist.
    const memory = createMemoryProvider(config({ provider: 'headroom-mcp' }), {
      workspaceRootPath: workspace,
      pythonPath: join(workspace, 'definitely-not-a-python-interpreter'),
    });

    const described = await memory.describe();
    expect(described.state).toBe('absent');
    expect(described.notes.join(' ')).toMatch(/not installed|could not/i);

    const found = await memory.search({ query: 'anything' });
    expect(found.available).toBe(false);
    if (!found.available) {
      // "absent" and "unprovisioned" must stay distinguishable — this is the
      // third state ADR-0029 C1 forced into the model.
      expect(found.reason).toBe('provider-absent');
      expect(found.reason).not.toBe('provider-unprovisioned');
    }
    await memory.dispose?.();
  });

  it('the built-in provider is READY with no setup at all — the default path', async () => {
    const described = await createMemoryProvider(config(), { workspaceRootPath: workspace }).describe();
    expect(described.state).toBe('ready');
    expect(described.requiresProvisioning).toBe(false);
  });

  it('every unavailable state still answers describe() rather than throwing', async () => {
    const cases: MemoryConfig[] = [
      config({ enabled: false }),
      config({ provider: 'nope' as MemoryConfig['provider'] }),
    ];
    for (const memoryConfig of cases) {
      const described = await createMemoryProvider(memoryConfig, {
        workspaceRootPath: workspace,
      }).describe();
      expect(typeof described.summary).toBe('string');
      expect(described.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('describe() honesty — the vocabulary must not flatter the provider', () => {
  it('the two providers disagree exactly where ADR-0029 says they do', async () => {
    const builtin = await createMemoryProvider(config({ provider: 'builtin-markdown' }), {
      workspaceRootPath: workspace,
    }).describe();
    const headroom = createMemoryProvider(config({ provider: 'headroom-mcp' }), {
      workspaceRootPath: workspace,
      pythonPath: join(workspace, 'no-such-python'),
    });
    const headroomCaps = await headroom.describe();

    // C2 — Headroom's surface collapses four-layer scoping to USER.
    expect(builtin.scopeLayers).toEqual(['user', 'session', 'agent', 'turn']);
    expect(headroomCaps.scopeLayers).toEqual(['user']);

    // C3 — Headroom's reads are prose, the built-in's are structured records.
    expect(builtin.structuredReads).toBe(true);
    expect(headroomCaps.structuredReads).toBe(false);

    // C1 — only one of them has a provisioning step that can fail.
    expect(builtin.requiresProvisioning).toBe(false);
    expect(headroomCaps.requiresProvisioning).toBe(true);

    // The disclosed egress difference, stated rather than buried.
    expect(builtin.egress).toBe('none');
    expect(headroomCaps.egress).toBe('first-run-model-fetch');

    await headroom.dispose?.();
  });
});
