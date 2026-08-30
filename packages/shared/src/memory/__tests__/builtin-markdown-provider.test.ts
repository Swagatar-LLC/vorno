/**
 * The built-in markdown provider, against real files on disk
 * (fork: PLAN-040 / SUV-0040).
 *
 * Deliberately not mocked. SUV-0040's acceptance says the frontmatter must be
 * "readable both by the test and by eye" and that archive markers must be
 * "observable on disk" — assertions that a fake filesystem would let us pass
 * while shipping something that never wrote a file. Every test here uses a real
 * temp directory and reads the bytes back.
 *
 * Each test pins its own clock, so decay behaviour is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuiltinMarkdownMemoryProvider } from '../builtin-markdown-provider.ts';
import { COLD_STORAGE_BANNER_PREFIX } from '../memory-file.ts';
import { MILLISECONDS_PER_DAY } from '../decay.ts';
import { readRetrievalLog, resolveMemoryStorePaths } from '../markdown-store.ts';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vorno-memory-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

let idCounter = 0;
function makeProvider(overrides: Partial<{ nowMs: number; halfLifeDays: number; topK: number; includeArchived: boolean }> = {}) {
  return new BuiltinMarkdownMemoryProvider({
    workspaceRootPath: workspace,
    halfLifeDays: overrides.halfLifeDays ?? 60,
    topK: overrides.topK ?? 5,
    includeArchived: overrides.includeArchived ?? false,
    now: () => overrides.nowMs ?? NOW,
    randomSuffix: () => `t${(idCounter += 1).toString(36).padStart(4, '0')}`,
  });
}

function entryFiles(): string[] {
  const dir = resolveMemoryStorePaths(workspace).entries;
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')) : [];
}

function archiveFiles(): string[] {
  const dir = resolveMemoryStorePaths(workspace).archive;
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')) : [];
}

describe('save and search', () => {
  it('writes a real markdown file whose frontmatter is readable by eye', () => {
    const provider = makeProvider();
    return provider
      .save({ facts: [{ content: 'Jeff is in the America/New_York timezone.', importance: 0.8, tags: ['profile'] }] })
      .then((result) => {
        expect(result.available).toBe(true);
        const files = entryFiles();
        expect(files).toHaveLength(1);

        const text = readFileSync(join(resolveMemoryStorePaths(workspace).entries, files[0]!), 'utf8');
        expect(text).toContain('importance: 0.8');
        expect(text).toContain('tags: [profile]');
        expect(text).toContain('created: 2026-08-28T12:00:00.000Z');
        expect(text).toContain('Jeff is in the America/New_York timezone.');
      });
  });

  it('skips empty facts rather than writing blank memories', async () => {
    const provider = makeProvider();
    const result = await provider.save({ facts: [{ content: '   ' }, { content: '' }] });
    expect(result.available && result.value).toEqual([]);
    expect(entryFiles()).toHaveLength(0);
  });

  it('finds a saved memory by a matching query', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'The deploy runbook lives in the ops repository.' }] });

    const found = await provider.search({ query: 'deploy runbook' });
    expect(found.available).toBe(true);
    if (!found.available) return;
    expect(found.value).toHaveLength(1);
    expect(found.value[0]!.content).toContain('deploy runbook');
    // Structured reads: the record carries real metadata, not parsed prose.
    expect(found.value[0]!.structured).toBe(true);
    expect(found.value[0]!.createdAt).toBe('2026-08-28T12:00:00.000Z');
  });

  it('returns nothing for a query that matches nothing, rather than the whole store', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'Something about deployment.' }] });
    const found = await provider.search({ query: 'marsupial taxonomy' });
    expect(found.available && found.value).toEqual([]);
  });

  it('honours topK', async () => {
    const provider = makeProvider({ topK: 2 });
    await provider.save({
      facts: [
        { content: 'branch policy one' },
        { content: 'branch policy two' },
        { content: 'branch policy three' },
      ],
    });
    const found = await provider.search({ query: 'branch policy' });
    expect(found.available && found.value).toHaveLength(2);
  });
});

describe('SUV-0029 acceptance: cross-session retrievability', () => {
  it('a memory written by one provider instance is found by a later, separate one', async () => {
    // Two instances over the same directory stand in for two sessions. If this
    // passed with a shared in-memory cache it would prove nothing, which is why
    // the second instance is constructed from scratch.
    const first = makeProvider();
    await first.save({ facts: [{ content: 'The staging database resets every Sunday night.' }] });

    const second = makeProvider();
    const found = await second.search({ query: 'staging database reset' });
    expect(found.available).toBe(true);
    if (!found.available) return;
    expect(found.value).toHaveLength(1);
    expect(found.value[0]!.content).toContain('staging database');
  });
});

describe('SUV-0040 acceptance: decay and importance affect ranking', () => {
  it('a fresher memory outranks a stale one matching the same terms', async () => {
    // 90 days at a 60-day half-life scores ~0.35 — the `review` band. Stale
    // enough to rank lower, not so stale that the sweep archives it out of the
    // comparison entirely (which is what 200 days would have done).
    const old = makeProvider({ nowMs: NOW - 90 * MILLISECONDS_PER_DAY });
    await old.save({ facts: [{ content: 'The release checklist has eleven steps.' }] });

    const recent = makeProvider();
    await recent.save({ facts: [{ content: 'The release checklist has twelve steps.' }] });

    const found = await makeProvider().search({ query: 'release checklist steps' });
    expect(found.available).toBe(true);
    if (!found.available) return;
    expect(found.value.length).toBeGreaterThanOrEqual(2);
    expect(found.value[0]!.content).toContain('twelve');
    expect(found.value[0]!.relevance).toBeGreaterThan(found.value[1]!.relevance);
  });

  it('a more important memory outranks a less important one of the same age', async () => {
    const provider = makeProvider();
    await provider.save({
      facts: [
        { content: 'The incident channel is called ops-alerts.', importance: 0.1 },
        { content: 'The incident channel is called ops-urgent.', importance: 0.85 },
      ],
    });

    const found = await makeProvider().search({ query: 'incident channel called' });
    expect(found.available).toBe(true);
    if (!found.available) return;
    expect(found.value[0]!.content).toContain('ops-urgent');
  });
});

describe('SUV-0040 acceptance: archive markers, observable on disk', () => {
  it('archives a decayed-out memory instead of deleting it, with a banner', async () => {
    const long_ago = makeProvider({ nowMs: NOW - 400 * MILLISECONDS_PER_DAY });
    await long_ago.save({ facts: [{ content: 'An old fact about the previous vendor.' }] });
    expect(entryFiles()).toHaveLength(1);
    expect(archiveFiles()).toHaveLength(0);

    // A save at the present triggers the sweep.
    const now = makeProvider();
    await now.save({ facts: [{ content: 'A brand new unrelated fact.' }] });

    const archived = archiveFiles();
    expect(archived).toHaveLength(1);

    const text = readFileSync(join(resolveMemoryStorePaths(workspace).archive, archived[0]!), 'utf8');
    expect(text).toContain('archived: 2026-08-28T12:00:00.000Z');
    expect(text).toContain('archive-reason: decayed out');
    expect(text).toContain(COLD_STORAGE_BANNER_PREFIX);
    // Nothing was deleted — the content is still there, in full.
    expect(text).toContain('An old fact about the previous vendor.');
  });

  it('never archives a pinned memory, however old', async () => {
    const ancient = makeProvider({ nowMs: NOW - 5000 * MILLISECONDS_PER_DAY });
    await ancient.save({ facts: [{ content: 'A permanent fact worth pinning.', importance: 1 }] });

    await makeProvider().save({ facts: [{ content: 'Trigger the sweep.' }] });

    expect(archiveFiles()).toHaveLength(0);
    expect(entryFiles()).toHaveLength(2);
  });

  it('excludes archived memories from searches by default', async () => {
    const old = makeProvider({ nowMs: NOW - 400 * MILLISECONDS_PER_DAY });
    await old.save({ facts: [{ content: 'Cold storage candidate about penguins.' }] });
    await makeProvider().save({ facts: [{ content: 'Unrelated trigger fact.' }] });
    expect(archiveFiles()).toHaveLength(1);

    const hot = await makeProvider().search({ query: 'penguins' });
    expect(hot.available && hot.value).toEqual([]);
  });

  it('reaches cold storage only when deliberately configured to, and marks what it finds', async () => {
    const old = makeProvider({ nowMs: NOW - 400 * MILLISECONDS_PER_DAY });
    await old.save({ facts: [{ content: 'Cold storage candidate about penguins.' }] });
    await makeProvider().save({ facts: [{ content: 'Unrelated trigger fact.' }] });

    const cold = await makeProvider({ includeArchived: true }).search({ query: 'penguins' });
    expect(cold.available).toBe(true);
    if (!cold.available) return;
    expect(cold.value).toHaveLength(1);
    // The uncertainty marker travels with the content.
    expect(cold.value[0]!.archived).toBe(true);
  });

  it('a request cannot widen past the configured cold-storage ceiling', async () => {
    const old = makeProvider({ nowMs: NOW - 400 * MILLISECONDS_PER_DAY });
    await old.save({ facts: [{ content: 'Cold storage candidate about penguins.' }] });
    await makeProvider().save({ facts: [{ content: 'Unrelated trigger fact.' }] });

    // Config says no; the request asking nicely must not override it, or
    // "reachable only on purpose" would depend on every caller's discipline.
    const found = await makeProvider({ includeArchived: false }).search({
      query: 'penguins',
      includeArchived: true,
    });
    expect(found.available && found.value).toEqual([]);
  });
});

describe('SUV-0040 acceptance: retrieval logging', () => {
  it('records every read with counts and kept ids, and no content', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'The API gateway timeout is thirty seconds.' }] });
    await provider.search({ query: 'gateway timeout' });

    const log = readRetrievalLog(resolveMemoryStorePaths(workspace));
    expect(log).toHaveLength(1);
    expect(log[0]!.provider).toBe('builtin-markdown');
    expect(log[0]!.query).toBe('gateway timeout');
    expect(log[0]!.loaded).toBe(1);
    expect(log[0]!.kept).toHaveLength(1);
    expect(log[0]!.ts).toBe('2026-08-28T12:00:00.000Z');

    // Paths and ids only — a log that duplicates the corpus is a second copy of
    // the corpus with none of its archiving discipline.
    const raw = readFileSync(resolveMemoryStorePaths(workspace).retrievalLog, 'utf8');
    expect(raw).not.toContain('thirty seconds');
  });

  it('logs a search that matched nothing, so silence is falsifiable', async () => {
    await makeProvider().save({ facts: [{ content: 'Something entirely unrelated.' }] });
    await makeProvider().search({ query: 'nonexistent topic' });

    const log = readRetrievalLog(resolveMemoryStorePaths(workspace));
    const last = log.at(-1)!;
    expect(last.query).toBe('nonexistent topic');
    expect(last.kept).toEqual([]);
  });

  it('reinforces cited memories — being retrieved resets the decay clock', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'A fact that keeps earning its tokens.' }] });

    const before = readFileSync(
      join(resolveMemoryStorePaths(workspace).entries, entryFiles()[0]!),
      'utf8',
    );
    expect(before).toContain('citations: 0');
    expect(before).not.toContain('last-cited:');

    const later = makeProvider({ nowMs: NOW + 10 * MILLISECONDS_PER_DAY });
    await later.search({ query: 'earning tokens' });

    const after = readFileSync(
      join(resolveMemoryStorePaths(workspace).entries, entryFiles()[0]!),
      'utf8',
    );
    expect(after).toContain('citations: 1');
    expect(after).toContain('last-cited: 2026-09-07T12:00:00.000Z');
    // Being read is not being edited: `updated` must not move.
    expect(after).toContain('updated: 2026-08-28T12:00:00.000Z');
  });
});

describe('scope trimming through the provider', () => {
  it('does not surface one session\'s scoped memory in another session', async () => {
    const provider = makeProvider();
    await provider.save({
      facts: [{ content: 'A secret about session alpha.' }],
      scope: { session: 'alpha' },
    });
    await provider.save({ facts: [{ content: 'A general fact about sessions.' }] });

    const other = await makeProvider().search({ query: 'session', scope: { session: 'beta' } });
    expect(other.available).toBe(true);
    if (!other.available) return;
    expect(other.value.map((record) => record.content)).toEqual(['A general fact about sessions.']);
  });

  it('surfaces a scoped memory back inside its own scope', async () => {
    const provider = makeProvider();
    await provider.save({
      facts: [{ content: 'A secret about session alpha.' }],
      scope: { session: 'alpha' },
    });
    const same = await makeProvider().search({ query: 'secret alpha', scope: { session: 'alpha' } });
    expect(same.available && same.value).toHaveLength(1);
  });
});

describe('describe()', () => {
  it('reports capabilities honestly, including the limitation', async () => {
    const capabilities = await makeProvider().describe();
    expect(capabilities.providerId).toBe('builtin-markdown');
    expect(capabilities.state).toBe('ready');
    expect(capabilities.search).toBe('lexical');
    expect(capabilities.structuredReads).toBe(true);
    expect(capabilities.decay).toBe(true);
    expect(capabilities.archive).toBe(true);
    expect(capabilities.retrievalLog).toBe(true);
    expect(capabilities.scopeLayers).toEqual(['user', 'session', 'agent', 'turn']);
  });

  it('can never report the "unprovisioned" state — that is the point of it', async () => {
    // ADR-0029's C1 cannot happen here. There is nothing to provision, which is
    // the entire argument for this provider being the default.
    expect((await makeProvider().describe()).requiresProvisioning).toBe(false);
    expect((await makeProvider().describe()).state).not.toBe('unprovisioned');
  });

  it('names its lexical limitation and points at the alternative', async () => {
    const notes = (await makeProvider().describe()).notes.join(' ');
    expect(notes.toLowerCase()).toContain('lexical');
    expect(notes.toLowerCase()).toContain('not semantic');
    expect(notes).toContain('Headroom');
  });

  it('declares no egress', async () => {
    expect((await makeProvider().describe()).egress).toBe('none');
  });
});

describe('SUV-0040 acceptance: no egress, asserted rather than reviewed', () => {
  it('the provider and its store import no network or subprocess module', () => {
    // Asserted against the source rather than by monkey-patching fetch, because
    // a runtime assertion only proves the code path a test happened to take.
    // This proves it for every path, including ones no test exercises.
    const sources = [
      'builtin-markdown-provider.ts',
      'markdown-store.ts',
      'memory-file.ts',
      'decay.ts',
      'lexical.ts',
    ].map((name) => readFileSync(join(import.meta.dir, '..', name), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/from\s+['"`]node:(https?|net|child_process|dgram|tls)['"`]/);
      expect(source).not.toMatch(/require\(['"`](https?|net|child_process)['"`]\)/);
      expect(source).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(source).not.toMatch(/\bXMLHttpRequest\b/);
      // No credential reads: this provider needs no key, and a key it never
      // reads is a key it can never leak.
      expect(source).not.toMatch(/API_KEY|OAUTH|SECRET|process\.env\./);
    }
  });

  it('touches only the workspace directory it was given', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'A fact that must stay local.' }] });
    await provider.search({ query: 'fact local' });

    // Everything written lives under the temp workspace; nothing escaped it.
    const paths = provider.getStorePaths();
    expect(paths.root.startsWith(workspace)).toBe(true);
    expect(existsSync(paths.entries)).toBe(true);
    expect(existsSync(paths.retrievalLog)).toBe(true);
  });
});

describe('failure tolerance', () => {
  it('reports unavailable rather than throwing when the store cannot be written', async () => {
    // A file where the store directory should be: mkdir fails, and the whole
    // operation has to degrade rather than take down the turn.
    const blocked = mkdtempSync(join(tmpdir(), 'vorno-memory-blocked-'));
    Bun.write(join(blocked, 'memory'), 'not a directory');

    const provider = new BuiltinMarkdownMemoryProvider({
      workspaceRootPath: blocked,
      halfLifeDays: 60,
      topK: 5,
      includeArchived: false,
      now: () => NOW,
      randomSuffix: () => 'blocked01',
    });

    const saved = await provider.save({ facts: [{ content: 'Will not land anywhere.' }] });
    // Either an empty id list or an explicit unavailable — never a throw.
    expect(saved.available ? saved.value : []).toEqual([]);

    const found = await provider.search({ query: 'anything' });
    expect(found.available ? found.value : []).toEqual([]);

    rmSync(blocked, { recursive: true, force: true });
  });

  it('skips an unparseable file instead of failing the whole search', async () => {
    const provider = makeProvider();
    await provider.save({ facts: [{ content: 'A perfectly good memory about badgers.' }] });
    await Bun.write(join(resolveMemoryStorePaths(workspace).entries, 'corrupt.md'), 'not a memory');

    const found = await provider.search({ query: 'badgers' });
    expect(found.available).toBe(true);
    if (!found.available) return;
    expect(found.value).toHaveLength(1);
  });
});
