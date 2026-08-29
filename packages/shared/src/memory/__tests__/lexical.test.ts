/**
 * Lexical matching and the scope trim (fork: PLAN-040 / SUV-0040).
 *
 * The scope-trim block is the security-relevant half of this file: it is the
 * post-retrieval gate's first step, and the failure it prevents is one session's
 * private memories surfacing in another.
 */

import { describe, expect, it } from 'bun:test';

import {
  PHRASE_MATCH_BONUS,
  applyScopeTrim,
  isInScope,
  lexicalScore,
  prepareQuery,
  tokenize,
} from '../lexical.ts';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops stop words', () => {
    expect(tokenize('The Quick brown-fox, and a DOG!')).toEqual(['quick', 'brown', 'fox', 'dog']);
  });

  it('drops single characters but keeps short meaningful terms', () => {
    expect(tokenize('a b go up')).toEqual(['go', 'up']);
  });

  it('keeps technical terms a longer stop list would have eaten', () => {
    // With no embeddings to fall back on, a dropped term is a lost result.
    expect(tokenize('can state will')).toEqual(['can', 'state', 'will']);
  });

  it('never throws on non-string input', () => {
    expect(tokenize(undefined as unknown as string)).toEqual([]);
    expect(tokenize(42 as unknown as string)).toEqual([]);
  });
});

describe('lexicalScore', () => {
  const entry = {
    content: 'One topic branch per plan is the rule for roadmap work.',
    tags: ['roadmap', 'branching'],
  };

  it('scores full term coverage at or near the maximum', () => {
    expect(lexicalScore(prepareQuery('topic branch plan'), entry)).toBeCloseTo(1, 5);
  });

  it('scores partial coverage proportionally', () => {
    const partial = lexicalScore(prepareQuery('topic branch unrelated nonsense'), entry);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it('scores zero when nothing matches', () => {
    expect(lexicalScore(prepareQuery('quantum entanglement'), entry)).toBe(0);
  });

  it('scores an empty query zero — "no query" is not "match everything"', () => {
    expect(lexicalScore(prepareQuery(''), entry)).toBe(0);
    expect(lexicalScore(prepareQuery('the and of'), entry)).toBe(0);
  });

  it('weights a tag hit above a body hit', () => {
    // A multi-term query, deliberately: with a single term both candidates
    // saturate at the 0..1 ceiling and the weighting is unobservable.
    const query = prepareQuery('branching zebra quokka');
    const tagged = { content: 'unrelated prose entirely', tags: ['branching'] };
    const inBody = { content: 'branching discussed', tags: [] };
    expect(lexicalScore(query, tagged)).toBeGreaterThan(lexicalScore(query, inBody));
  });

  it('adds a bonus for a verbatim phrase match', () => {
    const withPhrase = lexicalScore(prepareQuery('one topic branch per plan'), entry);
    const scrambled = lexicalScore(prepareQuery('plan per branch topic one'), entry);
    expect(withPhrase).toBeGreaterThanOrEqual(scrambled);
    expect(PHRASE_MATCH_BONUS).toBeGreaterThan(0);
  });

  it('is bounded at 1 even with tags and a phrase bonus stacked', () => {
    expect(lexicalScore(prepareQuery('roadmap branching'), entry)).toBeLessThanOrEqual(1);
  });

  it('does not reward repetition — frequency mostly measures length', () => {
    const repeated = { content: 'branch branch branch branch branch', tags: [] };
    const once = { content: 'branch', tags: [] };
    expect(lexicalScore(prepareQuery('branch'), repeated)).toBe(
      lexicalScore(prepareQuery('branch'), once),
    );
  });
});

describe('isInScope — the post-retrieval scope trim', () => {
  const target = { user: 'ws-1', session: 'sess-a' };

  it('lets an unscoped memory through to everything', () => {
    // A general fact about the user declares no layers, so nothing can mismatch.
    expect(isInScope({}, target)).toBe(true);
    expect(isInScope({}, undefined)).toBe(true);
  });

  it('lets a memory through when every layer it declares matches', () => {
    expect(isInScope({ user: 'ws-1' }, target)).toBe(true);
    expect(isInScope({ user: 'ws-1', session: 'sess-a' }, target)).toBe(true);
  });

  it("does NOT leak one session's memory into another", () => {
    // The failure this whole function exists to prevent.
    expect(isInScope({ session: 'sess-b' }, target)).toBe(false);
    expect(isInScope({ user: 'ws-1', session: 'sess-b' }, target)).toBe(false);
  });

  it("does NOT leak one workspace's memory into another", () => {
    expect(isInScope({ user: 'ws-2' }, target)).toBe(false);
  });

  it('treats a target that omits a declared layer as a MISMATCH, not a wildcard', () => {
    // The asymmetry that matters: if an omitted target layer were a wildcard, a
    // search that simply forgot to pass `session` would see every session's
    // private memories. Narrow memories stay narrow.
    expect(isInScope({ session: 'sess-a' }, { user: 'ws-1' })).toBe(false);
    expect(isInScope({ session: 'sess-a' }, undefined)).toBe(false);
    expect(isInScope({ agent: 'a1' }, target)).toBe(false);
    expect(isInScope({ turn: 't1' }, target)).toBe(false);
  });
});

describe('applyScopeTrim', () => {
  it('keeps in-scope entries and reports how many were trimmed', () => {
    const entries = [
      { id: 'a', scope: {} },
      { id: 'b', scope: { session: 'sess-a' } },
      { id: 'c', scope: { session: 'sess-b' } },
      { id: 'd', scope: { user: 'ws-9' } },
    ];
    const { kept, trimmed } = applyScopeTrim(entries, { user: 'ws-1', session: 'sess-a' });
    expect(kept.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(trimmed).toBe(2);
  });

  it('reports zero trimmed when everything is admissible', () => {
    const { kept, trimmed } = applyScopeTrim([{ scope: {} }], undefined);
    expect(kept).toHaveLength(1);
    expect(trimmed).toBe(0);
  });
});
