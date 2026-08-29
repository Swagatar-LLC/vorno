/**
 * The on-disk format of one built-in memory: a markdown file with frontmatter
 * (fork: PLAN-040 / SUV-0040).
 *
 * ## Why a hand-rolled parser rather than `gray-matter`
 *
 * `gray-matter` is already a dependency and the artifact plane uses it, so this
 * is a deliberate exception, made for two reasons:
 *
 * 1. **Round-trip exactness.** This module both reads and writes these files.
 *    A full YAML parser paired with a hand-written serializer is two grammars
 *    that can drift; one closed grammar that does both cannot. The memory
 *    schema is a fixed, flat set of scalars and one string array — a subset
 *    small enough to be defined completely and read by eye.
 * 2. **The no-egress guarantee is easier to keep true the fewer moving parts
 *    the provider has.** SUV-0040 asserts by *test* that this provider fetches
 *    nothing, spawns nothing, and reads no key. A closed parser over a closed
 *    grammar keeps that assertion cheap to defend.
 *
 * The format stays *compatible with* the shipped artifact plane — flat scalars
 * and arrays-of-scalars are exactly what its frontmatter indexer already
 * projects (PLAN-025) — so these files are queryable by that index without
 * inventing a parallel schema. Flatness is the compatibility contract, not a
 * simplification we took for convenience.
 *
 * ## The format
 *
 * ```markdown
 * ---
 * id: 20260828T193000-a1b2c3d4
 * created: 2026-08-28T19:30:00.000Z
 * updated: 2026-08-28T19:30:00.000Z
 * importance: 0.6
 * tags: [roadmap, headroom]
 * scope-user: jh
 * scope-session: 260828-pure-torrent
 * citations: 3
 * last-cited: 2026-08-29T08:00:00.000Z
 * ---
 *
 * The remembered content, verbatim.
 * ```
 *
 * Keys with no value are omitted entirely rather than written empty, so a file
 * says only what is true about it.
 */

import type { MemoryScope } from '@craft-agent/core/types';

/** Frontmatter keys, in the order they are written. Order is part of the format. */
const FIELD_ORDER = [
  'id',
  'created',
  'updated',
  'importance',
  'tags',
  'scope-user',
  'scope-session',
  'scope-agent',
  'scope-turn',
  'citations',
  'last-cited',
  'archived',
  'archive-reason',
  'supersedes',
] as const;

/**
 * The banner stamped onto an archived memory's body.
 *
 * Mandatory, and it travels with the content everywhere it goes. Cold content
 * may never be restated as a current fact: it was true at one time, and nothing
 * has verified it since. A file sitting in the archive directory without this
 * banner is a bug, which is why archiving is mechanical and never hand-done.
 */
export const COLD_STORAGE_BANNER_PREFIX =
  '> **⚠️ From cold storage — this was true at one time, but it may not be true now.**';

export function coldStorageBanner(archivedAt: string, reason: string): string {
  return `${COLD_STORAGE_BANNER_PREFIX} Archived ${archivedAt}; unverified since. Reason: ${reason}.`;
}

/** One memory, parsed. */
export interface MemoryFileEntry {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly scope: MemoryScope;
  readonly citations: number;
  readonly lastCitedAt?: string;
  readonly archivedAt?: string;
  readonly archiveReason?: string;
  readonly supersedes?: string;
  /** Absolute path this entry was read from. Not serialized. */
  readonly path?: string;
}

function escapeScalar(value: string): string {
  // The grammar has no quoting, so a value that would break the line grammar is
  // flattened rather than escaped. Memory content lives in the body; frontmatter
  // values are ids, dates, tags and short reasons, none of which need newlines.
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function serializeTags(tags: readonly string[]): string {
  return `[${tags.map((tag) => escapeScalar(tag)).filter(Boolean).join(', ')}]`;
}

function parseTags(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '[]') return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Render one memory as its file text. Deterministic: same entry, same bytes. */
export function serializeMemoryFile(entry: MemoryFileEntry): string {
  const values: Partial<Record<(typeof FIELD_ORDER)[number], string>> = {
    id: escapeScalar(entry.id),
    created: escapeScalar(entry.createdAt),
    updated: escapeScalar(entry.updatedAt),
    importance: String(entry.importance),
    tags: serializeTags(entry.tags),
    citations: String(entry.citations),
  };

  if (entry.scope.user) values['scope-user'] = escapeScalar(entry.scope.user);
  if (entry.scope.session) values['scope-session'] = escapeScalar(entry.scope.session);
  if (entry.scope.agent) values['scope-agent'] = escapeScalar(entry.scope.agent);
  if (entry.scope.turn) values['scope-turn'] = escapeScalar(entry.scope.turn);
  if (entry.lastCitedAt) values['last-cited'] = escapeScalar(entry.lastCitedAt);
  if (entry.archivedAt) values.archived = escapeScalar(entry.archivedAt);
  if (entry.archiveReason) values['archive-reason'] = escapeScalar(entry.archiveReason);
  if (entry.supersedes) values.supersedes = escapeScalar(entry.supersedes);

  const lines = FIELD_ORDER.filter((key) => values[key] !== undefined).map(
    (key) => `${key}: ${values[key]}`,
  );

  const body = entry.archivedAt
    ? `${coldStorageBanner(entry.archivedAt, entry.archiveReason ?? 'decayed out')}\n\n${entry.content.trim()}`
    : entry.content.trim();

  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

/**
 * Parse one memory file.
 *
 * Returns `null` when the text has no usable frontmatter block or no `id` —
 * never throws. A malformed file in the store is skipped, not fatal: one bad
 * file must not take out every search in the workspace.
 */
export function parseMemoryFile(text: string, path?: string): MemoryFileEntry | null {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return null;

  const header = normalized.slice(4, end);
  // Strip *every* leading newline, not just one. The serializer writes a blank
  // line between the closing fence and the body, so slicing a single `\n` here
  // leaves an empty first line — which silently defeated the banner strip
  // below, since the banner was never line zero.
  const body0 = normalized.slice(end + 4).replace(/^\n+/, '');
  let body = body0;

  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const id = fields.get('id');
  if (!id) return null;

  // The banner is written into the body on archive, so it must come back off on
  // read. Otherwise a round-trip stacks a second banner on every save.
  const bodyLines = body.split('\n');
  if (bodyLines[0]?.startsWith(COLD_STORAGE_BANNER_PREFIX)) {
    bodyLines.shift();
    while (bodyLines[0] === '') bodyLines.shift();
    body = bodyLines.join('\n');
  }

  const importanceRaw = Number(fields.get('importance'));
  const citationsRaw = Number(fields.get('citations'));

  const scope: MemoryScope = {};
  const user = fields.get('scope-user');
  const session = fields.get('scope-session');
  const agent = fields.get('scope-agent');
  const turn = fields.get('scope-turn');
  const scoped: Record<string, string> = {};
  if (user) scoped.user = user;
  if (session) scoped.session = session;
  if (agent) scoped.agent = agent;
  if (turn) scoped.turn = turn;
  Object.assign(scope, scoped);

  const created = fields.get('created') ?? '';
  const entry: MemoryFileEntry = {
    id,
    content: body.trim(),
    createdAt: created,
    updatedAt: fields.get('updated') ?? created,
    importance: Number.isFinite(importanceRaw) ? importanceRaw : 0.5,
    tags: parseTags(fields.get('tags') ?? ''),
    scope,
    citations: Number.isFinite(citationsRaw) && citationsRaw >= 0 ? Math.floor(citationsRaw) : 0,
    ...(fields.get('last-cited') ? { lastCitedAt: fields.get('last-cited') } : {}),
    ...(fields.get('archived') ? { archivedAt: fields.get('archived') } : {}),
    ...(fields.get('archive-reason') ? { archiveReason: fields.get('archive-reason') } : {}),
    ...(fields.get('supersedes') ? { supersedes: fields.get('supersedes') } : {}),
    ...(path ? { path } : {}),
  };

  return entry;
}

/**
 * A filesystem-safe, sortable, collision-resistant memory id.
 *
 * Time-prefixed so `ls` in the store directory is chronological, which is the
 * ordering a human browsing their own memories expects. The suffix comes from
 * the caller so this function stays pure and testable — the store supplies
 * randomness, this module supplies the shape.
 */
export function buildMemoryId(nowMs: number, suffix: string): string {
  const iso = new Date(nowMs).toISOString();
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const clean = suffix.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || '0';
  return `${stamp}-${clean}`;
}

/** Map an id to its file name. Ids are already filesystem-safe by construction. */
export function memoryFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}
