/**
 * Lexical matching and scope trimming for the built-in markdown provider
 * (fork: PLAN-040 / SUV-0040).
 *
 * Pure functions over already-loaded entries — no I/O, no clock.
 *
 * ## This is lexical, not semantic, and that is the deal
 *
 * There is no embedding here and there will not be one: vectors are what
 * `headroom-mcp` is for, and building an index is PLAN-040's Vector-DB
 * non-goal. The honest cost, stated in `describe()` and in the docs rather than
 * buried: this provider will miss paraphrases a vector index would catch. Ask
 * it about "the thing we decided about branching" and it will not find a memory
 * phrased "one topic branch per plan" unless a word overlaps.
 *
 * What it buys is the property that makes it the *default*: zero provisioning.
 * No Python, no ~86 MB model download, no provider key, no network. A user who
 * turns memory on gets working memory, not a setup errand.
 */

import type { MemoryScope } from '@craft-agent/core/types';

/**
 * Words carrying no retrieval signal, dropped from queries and documents.
 *
 * Short and English-only on purpose. A long stop list starts deleting terms
 * that matter in a technical corpus ("can", "will", "state"), and with no
 * embeddings to fall back on, a dropped term is a lost result.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'their', 'them', 'they', 'this', 'to', 'was', 'were', 'what', 'when',
  'which', 'who', 'with', 'you', 'your',
]);

/** Split text into lowercase alphanumeric terms, stop words removed. */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

/** A tokenized query, prepared once and reused across every candidate. */
export interface PreparedQuery {
  readonly raw: string;
  readonly terms: readonly string[];
  readonly unique: ReadonlySet<string>;
}

export function prepareQuery(query: string): PreparedQuery {
  const terms = tokenize(query);
  return { raw: (query ?? '').trim().toLowerCase(), terms, unique: new Set(terms) };
}

/** Weight of a tag hit relative to a body hit. Tags are curated; bodies are prose. */
export const TAG_MATCH_WEIGHT = 1.5;
/** Bonus applied when the whole query appears verbatim in the content. */
export const PHRASE_MATCH_BONUS = 0.25;

/**
 * Score one memory against a prepared query, in 0..1.
 *
 * Coverage-based rather than frequency-based: what fraction of the query's
 * distinct terms this memory accounts for, with tag hits worth more than body
 * hits and a bonus for containing the query verbatim. Term *frequency* is
 * deliberately not used — a memory that says "branch" nine times is not nine
 * times more about branching, and in a corpus of short human-written notes,
 * frequency mostly rewards length.
 *
 * An empty query scores 0 for everything: "no query" is not "match all", and a
 * caller who wanted everything should enumerate the store, not search it.
 */
export function lexicalScore(
  query: PreparedQuery,
  entry: { content: string; tags: readonly string[] },
): number {
  if (query.unique.size === 0) return 0;

  const contentTerms = new Set(tokenize(entry.content));
  const tagTerms = new Set(entry.tags.flatMap((tag) => tokenize(tag)));

  let matched = 0;
  for (const term of query.unique) {
    if (tagTerms.has(term)) matched += TAG_MATCH_WEIGHT;
    else if (contentTerms.has(term)) matched += 1;
  }

  let score = matched / query.unique.size;

  if (query.raw.length > 2 && entry.content.toLowerCase().includes(query.raw)) {
    score += PHRASE_MATCH_BONUS;
  }

  return Math.min(1, score);
}

/**
 * The scope trim — step 1 of the post-retrieval gate, adapted to this seam.
 *
 * A memory is admissible for a target scope when **every layer the memory
 * declares matches the target's value at that layer**. Read the two failure
 * modes it rules out:
 *
 * - A memory pinned to session A must not surface in session B. It declares
 *   `session: A`; the target says `session: B`; mismatch, dropped.
 * - A memory that declares nothing (a general fact about the user) surfaces
 *   everywhere. It declares no layers, so there is nothing to mismatch.
 *
 * Note the asymmetry, which is the correct one: an *unscoped* memory is broad
 * and travels; a *scoped* memory is narrow and stays. A target that omits a
 * layer the memory declares is a mismatch, not a wildcard — otherwise a search
 * that forgot to pass `session` would silently see every session's private
 * memories, which is exactly the leak the gate exists to prevent.
 */
export function isInScope(entryScope: MemoryScope, target: MemoryScope | undefined): boolean {
  const scope = target ?? {};
  if (entryScope.user && entryScope.user !== scope.user) return false;
  if (entryScope.session && entryScope.session !== scope.session) return false;
  if (entryScope.agent && entryScope.agent !== scope.agent) return false;
  if (entryScope.turn && entryScope.turn !== scope.turn) return false;
  return true;
}

/** Drop out-of-scope entries, reporting how many were trimmed for the log. */
export function applyScopeTrim<T extends { scope: MemoryScope }>(
  entries: readonly T[],
  target: MemoryScope | undefined,
): { kept: T[]; trimmed: number } {
  const kept = entries.filter((entry) => isInScope(entry.scope, target));
  return { kept, trimmed: entries.length - kept.length };
}
