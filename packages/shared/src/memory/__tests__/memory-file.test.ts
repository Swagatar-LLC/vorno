/**
 * The on-disk memory file format (fork: PLAN-040 / SUV-0040).
 *
 * The round-trip tests are the point of this file. `memory-file.ts` hand-rolls
 * both halves of the grammar precisely so they cannot drift, and the only way
 * that claim stays true is if a test asserts it.
 */

import { describe, expect, it } from 'bun:test';

import {
  COLD_STORAGE_BANNER_PREFIX,
  buildMemoryId,
  coldStorageBanner,
  memoryFileName,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFileEntry,
} from '../memory-file.ts';

const BASE: MemoryFileEntry = {
  id: '20260828T120000Z-abcd1234',
  content: 'Jeff prefers absolute dates over relative ones in written records.',
  createdAt: '2026-08-28T12:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
  importance: 0.6,
  tags: ['preferences', 'writing'],
  scope: {},
  citations: 0,
};

describe('serialize/parse round trip', () => {
  it('round-trips a minimal entry byte-for-byte through both directions', () => {
    const text = serializeMemoryFile(BASE);
    const parsed = parseMemoryFile(text);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      id: BASE.id,
      content: BASE.content,
      createdAt: BASE.createdAt,
      updatedAt: BASE.updatedAt,
      importance: BASE.importance,
      citations: 0,
    });
    expect(parsed?.tags).toEqual(['preferences', 'writing']);
    // Re-serializing the parsed entry must produce the identical file.
    expect(serializeMemoryFile(parsed as MemoryFileEntry)).toBe(text);
  });

  it('round-trips every optional field', () => {
    const full: MemoryFileEntry = {
      ...BASE,
      scope: { user: 'ws-1', session: 'sess-2', agent: 'agent-3', turn: 'turn-4' },
      citations: 7,
      lastCitedAt: '2026-08-29T08:00:00.000Z',
      supersedes: '20260101T000000Z-old00000',
    };
    const parsed = parseMemoryFile(serializeMemoryFile(full));
    expect(parsed?.scope).toEqual(full.scope);
    expect(parsed?.citations).toBe(7);
    expect(parsed?.lastCitedAt).toBe(full.lastCitedAt);
    expect(parsed?.supersedes).toBe(full.supersedes);
  });

  it('omits absent keys rather than writing them empty', () => {
    // A file should say only what is true about it. An empty `archived:` line
    // reads as "this was archived, at no particular time".
    const text = serializeMemoryFile(BASE);
    expect(text).not.toContain('archived:');
    expect(text).not.toContain('scope-user:');
    expect(text).not.toContain('supersedes:');
    expect(text).toContain('citations: 0');
  });

  it('is deterministic — same entry, same bytes', () => {
    expect(serializeMemoryFile(BASE)).toBe(serializeMemoryFile({ ...BASE }));
  });

  it('handles an empty tag list', () => {
    const parsed = parseMemoryFile(serializeMemoryFile({ ...BASE, tags: [] }));
    expect(parsed?.tags).toEqual([]);
  });
});

describe('archive markers and the cold-storage banner', () => {
  const archived: MemoryFileEntry = {
    ...BASE,
    archivedAt: '2026-09-01T00:00:00.000Z',
    archiveReason: 'decayed out (score 0.120 after 180d)',
  };

  it('writes the banner into the body and the marker into frontmatter', () => {
    const text = serializeMemoryFile(archived);
    expect(text).toContain('archived: 2026-09-01T00:00:00.000Z');
    expect(text).toContain('archive-reason: decayed out (score 0.120 after 180d)');
    expect(text).toContain(COLD_STORAGE_BANNER_PREFIX);
    expect(text).toContain(coldStorageBanner(archived.archivedAt!, archived.archiveReason!));
  });

  it('strips the banner on read so a round trip cannot stack a second one', () => {
    // Without this, every save of an archived memory prepends another banner
    // and the file grows a banner per write.
    const once = serializeMemoryFile(archived);
    const parsed = parseMemoryFile(once);
    expect(parsed?.content).toBe(BASE.content);
    expect(parsed?.content).not.toContain(COLD_STORAGE_BANNER_PREFIX);
    const twice = serializeMemoryFile(parsed as MemoryFileEntry);
    expect(twice).toBe(once);
    expect(twice.split(COLD_STORAGE_BANNER_PREFIX).length - 1).toBe(1);
  });

  it('keeps the archive marker through the round trip', () => {
    const parsed = parseMemoryFile(serializeMemoryFile(archived));
    expect(parsed?.archivedAt).toBe(archived.archivedAt);
    expect(parsed?.archiveReason).toBe(archived.archiveReason);
  });
});

describe('parse tolerance', () => {
  it('returns null rather than throwing on unusable input', () => {
    expect(parseMemoryFile('')).toBeNull();
    expect(parseMemoryFile('no frontmatter here')).toBeNull();
    expect(parseMemoryFile('---\nunterminated: yes\n')).toBeNull();
    // No id means nothing can address this memory, so it is not a memory.
    expect(parseMemoryFile('---\ncreated: 2026-01-01\n---\n\nbody')).toBeNull();
    expect(parseMemoryFile(undefined as unknown as string)).toBeNull();
  });

  it('survives a malformed field by defaulting it, not by discarding the file', () => {
    const text = '---\nid: x1\nimportance: banana\ncitations: -4\n---\n\nstill useful\n';
    const parsed = parseMemoryFile(text);
    expect(parsed?.id).toBe('x1');
    expect(parsed?.content).toBe('still useful');
    expect(parsed?.importance).toBe(0.5);
    expect(parsed?.citations).toBe(0);
  });

  it('accepts CRLF line endings', () => {
    const text = serializeMemoryFile(BASE).replace(/\n/g, '\r\n');
    expect(parseMemoryFile(text)?.id).toBe(BASE.id);
  });

  it('reads a hand-written file — the format is meant to be editable by eye', () => {
    const handWritten = [
      '---',
      'id: my-note',
      'created: 2026-08-01T00:00:00.000Z',
      'updated: 2026-08-01T00:00:00.000Z',
      'importance: 0.9',
      'tags: [alpha, beta]',
      'citations: 0',
      '---',
      '',
      'A fact I typed in myself.',
      '',
    ].join('\n');
    const parsed = parseMemoryFile(handWritten);
    expect(parsed?.id).toBe('my-note');
    expect(parsed?.tags).toEqual(['alpha', 'beta']);
    expect(parsed?.content).toBe('A fact I typed in myself.');
  });

  it('flattens newlines out of frontmatter values so the grammar cannot be broken', () => {
    const text = serializeMemoryFile({ ...BASE, archiveReason: 'line one\nline two' , archivedAt: '2026-09-01T00:00:00.000Z'});
    const headerEnd = text.indexOf('\n---', 3);
    const header = text.slice(0, headerEnd);
    expect(header.split('archive-reason:').length - 1).toBe(1);
    expect(parseMemoryFile(text)?.archiveReason).toBe('line one line two');
  });
});

describe('ids and file names', () => {
  it('builds a time-prefixed, sortable id', () => {
    const early = buildMemoryId(Date.parse('2026-01-01T00:00:00.000Z'), 'aaaa1111');
    const late = buildMemoryId(Date.parse('2026-12-31T23:59:59.000Z'), 'bbbb2222');
    expect(early < late).toBe(true);
    expect(early).toMatch(/^\d{8}T\d{6}Z-[a-z0-9]+$/);
  });

  it('sanitizes a hostile suffix rather than trusting it', () => {
    const id = buildMemoryId(Date.parse('2026-01-01T00:00:00.000Z'), '../../etc/passwd');
    expect(id).not.toContain('/');
    expect(id).not.toContain('.');
    expect(memoryFileName(id)).not.toContain('/');
  });

  it('never produces a file name that escapes its directory', () => {
    expect(memoryFileName('../../evil')).toBe('.._.._evil.md');
    expect(memoryFileName('ok-id')).toBe('ok-id.md');
  });
});
