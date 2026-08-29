/**
 * Host-invoked memory at the session boundary (fork: PLAN-040 / SUV-0029).
 *
 * The load-bearing test in this file is the byte-identical one: with memory
 * off, the assembled prompt must be exactly what it would have been if this
 * feature did not exist. Everything else about "Vorno is fully functional with
 * the feature disabled" is a claim; that one is a check.
 */

import { describe, expect, it } from 'bun:test';

import {
  MEMORY_CONFIG_DEFAULTS,
  memoryAvailable,
  memoryUnavailable,
  type MemoryConfig,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryUnavailableReason,
} from '@craft-agent/core/types';

import {
  MAX_FACTS_PER_TURN,
  MEMORY_CONTEXT_CLOSING,
  MEMORY_CONTEXT_HEADING,
  loadMemoryContext,
  parseExtractedFacts,
  renderMemoryBlock,
  saveTurnMemory,
} from '../session-memory.ts';

const config = (overrides: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...MEMORY_CONFIG_DEFAULTS,
  enabled: true,
  ...overrides,
});

function record(content: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: content.slice(0, 8), content, relevance: 0.8, structured: true, ...extra };
}

/** A provider that answers with whatever the test hands it. */
function stubProvider(options: {
  search?: () => ReturnType<MemoryProvider['search']>;
  save?: (request: Parameters<MemoryProvider['save']>[0]) => ReturnType<MemoryProvider['save']>;
}): MemoryProvider & { saved: Array<Parameters<MemoryProvider['save']>[0]> } {
  const saved: Array<Parameters<MemoryProvider['save']>[0]> = [];
  return {
    id: 'stub',
    saved,
    async search() {
      return options.search ? options.search() : memoryAvailable([]);
    },
    async save(request) {
      saved.push(request);
      return options.save ? options.save(request) : memoryAvailable(['id-1']);
    },
    async describe() {
      return {
        providerId: 'stub',
        state: 'ready',
        summary: 'stub',
        search: 'lexical',
        scopeLayers: [],
        structuredReads: true,
        supersession: false,
        decay: false,
        archive: false,
        retrievalLog: false,
        requiresProvisioning: false,
        egress: 'none',
        notes: [],
      };
    },
  };
}

describe('renderMemoryBlock', () => {
  it('renders retrieved memories inside a delimited block', () => {
    const block = renderMemoryBlock([record('The team stands up at 9:30.')]);
    expect(block).toContain(MEMORY_CONTEXT_HEADING);
    expect(block).toContain(MEMORY_CONTEXT_CLOSING);
    expect(block).toContain('The team stands up at 9:30.');
  });

  it('returns null for an empty result set rather than an empty block', () => {
    expect(renderMemoryBlock([])).toBeNull();
  });

  it('carries the cold-storage marker into the prompt', () => {
    // The uncertainty marker travels with the content everywhere it goes.
    // Cold content may never be restated as a current fact.
    const block = renderMemoryBlock([record('An old vendor detail.', { archived: true })]);
    expect(block).toContain('cold storage');
    expect(block).toContain('unverified since');
  });

  it('does not mark a hot memory as cold', () => {
    expect(renderMemoryBlock([record('A current fact.')])).not.toContain('cold storage');
  });

  it('caps the block so memory cannot crowd out the actual request', () => {
    const huge = Array.from({ length: 200 }, (_unused, index) =>
      record(`Memory number ${index}: ${'x'.repeat(900)}`),
    );
    const block = renderMemoryBlock(huge)!;
    expect(block.length).toBeLessThan(10_000);
    expect(block).toContain(MEMORY_CONTEXT_CLOSING);
  });

  it('truncates an over-long single memory rather than dropping it', () => {
    const block = renderMemoryBlock([record('y'.repeat(5_000))])!;
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(2_000);
  });
});

describe('loadMemoryContext — the host-invoked read', () => {
  it('returns the block when memory is on and something matched', async () => {
    const provider = stubProvider({
      search: async () => memoryAvailable([record('Deploys happen on Tuesdays.')]),
    });
    const block = await loadMemoryContext(provider, config(), { query: 'when do we deploy' });
    expect(block).toContain('Deploys happen on Tuesdays.');
  });

  it('returns null when memory is DISABLED — the byte-identical path', async () => {
    const provider = stubProvider({
      search: async () => memoryAvailable([record('Should never be spliced.')]),
    });
    expect(await loadMemoryContext(provider, config({ enabled: false }), { query: 'x' })).toBeNull();
  });

  it('returns null when autoLoad is off, even with memory enabled', async () => {
    const provider = stubProvider({
      search: async () => memoryAvailable([record('Should never be spliced.')]),
    });
    expect(await loadMemoryContext(provider, config({ autoLoad: false }), { query: 'x' })).toBeNull();
  });

  it('returns null for every unavailable reason, without leaking plumbing into the prompt', async () => {
    // The reason is not swallowed — it goes to the debug log. What must not
    // happen is the model being asked to reason about our provider states.
    const reasons: MemoryUnavailableReason[] = [
      'disabled',
      'not-configured',
      'provider-absent',
      'provider-unprovisioned',
      'provider-error',
    ];
    for (const reason of reasons) {
      const provider = stubProvider({ search: async () => memoryUnavailable(reason) });
      expect(await loadMemoryContext(provider, config(), { query: 'x' })).toBeNull();
    }
  });

  it('returns null on an empty query rather than searching for nothing', async () => {
    expect(await loadMemoryContext(stubProvider({}), config(), { query: '   ' })).toBeNull();
  });

  it('survives a provider that breaks its no-throw contract', async () => {
    const rogue: MemoryProvider = {
      id: 'rogue',
      async search() {
        throw new Error('contract violated');
      },
      async save() {
        throw new Error('contract violated');
      },
      async describe() {
        throw new Error('contract violated');
      },
    };
    expect(await loadMemoryContext(rogue, config(), { query: 'x' })).toBeNull();
  });
});

describe('parseExtractedFacts', () => {
  it('parses one fact per line', () => {
    const facts = parseExtractedFacts('Jeff prefers absolute dates.\nThe repo uses Bun.');
    expect(facts.map((fact) => fact.content)).toEqual([
      'Jeff prefers absolute dates.',
      'The repo uses Bun.',
    ]);
  });

  it('treats NONE as no facts — "nothing durable" must be expressible', () => {
    // Without this, a model asked for facts will always find some.
    expect(parseExtractedFacts('NONE')).toEqual([]);
    expect(parseExtractedFacts('  none  ')).toEqual([]);
  });

  it('returns nothing for empty or absent replies', () => {
    expect(parseExtractedFacts(null)).toEqual([]);
    expect(parseExtractedFacts('')).toEqual([]);
    expect(parseExtractedFacts('   \n  \n ')).toEqual([]);
  });

  it('strips bullets and numbering the prompt asked the model not to use', () => {
    const facts = parseExtractedFacts('- First fact here\n* Second fact here\n1. Third fact here');
    expect(facts.map((fact) => fact.content)).toEqual([
      'First fact here',
      'Second fact here',
      'Third fact here',
    ]);
  });

  it('caps the number of facts a single turn may contribute', () => {
    const many = Array.from({ length: 20 }, (_unused, i) => `Fact number ${i}`).join('\n');
    expect(parseExtractedFacts(many)).toHaveLength(MAX_FACTS_PER_TURN);
  });

  it('drops fragments too short to be a fact', () => {
    expect(parseExtractedFacts('ok\nA real durable fact about the project.')).toHaveLength(1);
  });
});

describe('saveTurnMemory — the host-invoked write', () => {
  const transcript = 'A reasonably long exchange about how the team prefers to work together.';

  it('saves facts the mini model extracted', async () => {
    const provider = stubProvider({});
    const ids = await saveTurnMemory(provider, config(), {
      transcript,
      summarize: async () => 'The team prefers async standups.',
    });
    expect(ids).toEqual(['id-1']);
    expect(provider.saved[0]!.facts[0]!.content).toBe('The team prefers async standups.');
  });

  it('does nothing when memory is disabled', async () => {
    const provider = stubProvider({});
    expect(
      await saveTurnMemory(provider, config({ enabled: false }), {
        transcript,
        summarize: async () => 'A fact.',
      }),
    ).toEqual([]);
    expect(provider.saved).toHaveLength(0);
  });

  it('does nothing when autoSave is off', async () => {
    const provider = stubProvider({});
    expect(
      await saveTurnMemory(provider, config({ autoSave: false }), {
        transcript,
        summarize: async () => 'A fact.',
      }),
    ).toEqual([]);
    expect(provider.saved).toHaveLength(0);
  });

  it('degrades quietly with no summarizer — reading memory must still work', async () => {
    const provider = stubProvider({});
    expect(await saveTurnMemory(provider, config(), { transcript })).toEqual([]);
    expect(provider.saved).toHaveLength(0);
  });

  it('skips a trivially short turn without paying for a model call', async () => {
    let called = false;
    await saveTurnMemory(stubProvider({}), config(), {
      transcript: 'hi',
      summarize: async () => {
        called = true;
        return 'A fact.';
      },
    });
    expect(called).toBe(false);
  });

  it('does not save when the model correctly finds nothing durable', async () => {
    const provider = stubProvider({});
    expect(await saveTurnMemory(provider, config(), { transcript, summarize: async () => 'NONE' })).toEqual(
      [],
    );
    expect(provider.saved).toHaveLength(0);
  });

  it('returns empty and never throws when the provider is unavailable', async () => {
    const provider = stubProvider({ save: async () => memoryUnavailable('provider-absent') });
    expect(
      await saveTurnMemory(provider, config(), { transcript, summarize: async () => 'A fact.' }),
    ).toEqual([]);
  });

  it('never throws when the summarizer itself fails', async () => {
    expect(
      await saveTurnMemory(stubProvider({}), config(), {
        transcript,
        summarize: async () => {
          throw new Error('mini model unreachable');
        },
      }),
    ).toEqual([]);
  });
});
