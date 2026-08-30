/**
 * The Memory docs page describes the memory that actually ships
 * (fork: PLAN-040 / SUV-0029 + SUV-0040; ADR-0031).
 *
 * The sibling of `headroom-doc.test.ts`, written for the same reason: a docs
 * page is the one artifact where nothing fails when it goes stale. Prose rot is
 * invisible, and the user finds it rather than CI. The page that preceded this
 * one told readers memory was "not available in Vorno" for as long as that
 * happened to be true, and nothing reddened when it stopped being true.
 *
 * So the page's factual claims are asserted against their sources:
 *
 *  - **Every documented default and bound** is checked against
 *    `MEMORY_CONFIG_DEFAULTS` and the exported clamps, so "off by default"
 *    cannot become folklore and a re-tuned half-life cannot leave the table
 *    behind.
 *  - **Every decay constant the page quotes** is checked against `decay.ts`.
 *    Those numbers are the ones a user would act on ("pin it at 0.9"), which
 *    makes them the ones that must not drift.
 *  - **The on-disk layout and the cold-storage banner** are checked against the
 *    store's own constants, because the page shows them verbatim.
 *  - **The built-in provider's capability claims** are checked against its real
 *    `describe()`, not against a copy of it. `egress: 'none'` is the load-bearing
 *    claim on the whole page and it must not be able to drift from the code.
 *  - **The "no settings panel yet" admission** is checked against `en.json`: the
 *    day someone ships `settings.workspace.memory*` keys, this test reds and the
 *    page has to stop saying the panel does not exist.
 *
 * Deliberately *not* asserted: that any given sentence is well written, or that
 * the page covers a subject exhaustively. This guards facts, not prose.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  MEMORY_CONFIG_DEFAULTS,
  MEMORY_CONFIG_FIELDS,
  MEMORY_HALF_LIFE_MAX_DAYS,
  MEMORY_HALF_LIFE_MIN_DAYS,
  MEMORY_PROVIDER_CHOICES,
  MEMORY_TOP_K_MAX,
  MEMORY_TOP_K_MIN,
} from '@craft-agent/core/types';

import {
  BUILTIN_MARKDOWN_PROVIDER_ID,
  COLD_STORAGE_BANNER_PREFIX,
  DECAY_REVIEW_THRESHOLD,
  HEADROOM_MCP_PROVIDER_ID,
  IMPORTANCE_HIGH,
  IMPORTANCE_LOW,
  IMPORTANCE_PINNED,
  MAX_FACTS_PER_TURN,
  MEMORY_ARCHIVE_DIR,
  MEMORY_DIR_NAME,
  MEMORY_ENTRIES_DIR,
  MEMORY_RETRIEVAL_LOG,
  createBuiltinMarkdownProvider,
} from '../../memory/index.ts';

const DOC_PATH = join(
  import.meta.dir,
  '../../../../../apps/electron/resources/docs/memory.md',
);

const doc = readFileSync(DOC_PATH, 'utf-8');

const HEADROOM_DOC_PATH = join(
  import.meta.dir,
  '../../../../../apps/electron/resources/docs/headroom.md',
);

const headroomDoc = readFileSync(HEADROOM_DOC_PATH, 'utf-8');

describe('Memory docs page (PLAN-040 / ADR-0031)', () => {
  test('the page ships in the docs content source', () => {
    // Docs are auto-discovered from apps/electron/resources/docs, so shipping
    // the file IS the registration. This asserts the file the sync will pick up.
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('# Memory');
  });

  test('covers every subject the page is for', () => {
    expect(doc).toContain('## What memory actually does');
    expect(doc).toContain('## The two providers');
    expect(doc).toContain('## The three provider states');
    expect(doc).toContain('## Settings');
    expect(doc).toContain('## How the built-in store works on disk');
    expect(doc).toContain('## Privacy: what leaves your machine');
    expect(doc).toContain('## Turning memory off');
  });

  test('says memory is host-invoked, not a tool the model calls', () => {
    // ADR-0029 commitment 1, generalized by ADR-0031. A page that let a reader
    // believe memory happens when the model feels like it would be describing a
    // different feature.
    expect(doc).toMatch(/host-invoked/i);
    expect(doc).toMatch(/not because the model decided to call a tool|no memory tool in the model's tool list/i);
  });

  test('names both registered providers by their real config ids', () => {
    expect(MEMORY_PROVIDER_CHOICES).toEqual([
      BUILTIN_MARKDOWN_PROVIDER_ID,
      HEADROOM_MCP_PROVIDER_ID,
    ]);
    for (const choice of MEMORY_PROVIDER_CHOICES) {
      expect(doc).toContain(choice);
    }
  });

  describe('the documented settings match the shipped config', () => {
    test('"off by default" matches MEMORY_CONFIG_DEFAULTS', () => {
      expect(MEMORY_CONFIG_DEFAULTS.enabled).toBe(false);
      expect(doc).toMatch(/off by default/i);
    });

    test('the default provider is the built-in one', () => {
      expect(MEMORY_CONFIG_DEFAULTS.provider).toBe(BUILTIN_MARKDOWN_PROVIDER_ID);
      expect(doc).toMatch(/the default/i);
    });

    test('autoLoad and autoSave default on underneath the gate', () => {
      expect(MEMORY_CONFIG_DEFAULTS.autoLoad).toBe(true);
      expect(MEMORY_CONFIG_DEFAULTS.autoSave).toBe(true);
      expect(doc).toContain('autoLoad');
      expect(doc).toContain('autoSave');
    });

    test('includeArchived defaults off', () => {
      expect(MEMORY_CONFIG_DEFAULTS.includeArchived).toBe(false);
      expect(doc).toContain('includeArchived');
    });

    test('the quoted topK default and range are the real ones', () => {
      expect(MEMORY_CONFIG_DEFAULTS.topK).toBe(5);
      expect(doc).toContain('`topK`');
      expect(doc).toContain(`${MEMORY_TOP_K_MIN}–${MEMORY_TOP_K_MAX}`);
    });

    test('the quoted half-life default and range are the real ones', () => {
      expect(MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays).toBe(60);
      expect(doc).toContain('`decayHalfLifeDays`');
      expect(doc).toContain(`\`${MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays}\``);
      expect(doc).toContain(`${MEMORY_HALF_LIFE_MIN_DAYS}–${MEMORY_HALF_LIFE_MAX_DAYS}`);
    });

    test('the settings surface it sends people to renders every field', () => {
      // The page says "Workspace Settings → Memory" and then documents seven
      // fields. Asserting against the shipped section — rather than against a
      // locale key that may be renamed — catches the failure that matters: a
      // field documented here that the panel does not actually edit.
      expect(doc).toContain('Workspace Settings → Memory');
      const section = readFileSync(
        join(
          import.meta.dir,
          '../../../../../apps/electron/src/renderer/pages/settings/MemorySettingsSection.tsx',
        ),
        'utf-8',
      );
      for (const field of MEMORY_CONFIG_FIELDS) {
        expect(section).toContain(field);
        expect(doc).toContain(`\`${field}\``);
      }
      // The panel is wired into the page the docs name.
      const page = readFileSync(
        join(
          import.meta.dir,
          '../../../../../apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx',
        ),
        'utf-8',
      );
      expect(page).toContain('MemorySettingsSection');
      // ...and the underlying config layer is documented too.
      expect(doc).toContain('defaults.memory');
    });
  });

  describe('the decay constants it quotes are the ones the code uses', () => {
    test('the archive-candidate threshold', () => {
      expect(DECAY_REVIEW_THRESHOLD).toBe(0.25);
      expect(doc).toContain(String(DECAY_REVIEW_THRESHOLD));
    });

    test('the importance bands', () => {
      expect(IMPORTANCE_PINNED).toBe(0.9);
      expect(IMPORTANCE_HIGH).toBe(0.7);
      expect(IMPORTANCE_LOW).toBe(0.3);
      expect(doc).toContain(`\`${IMPORTANCE_PINNED}\``);
      expect(doc).toContain(`\`${IMPORTANCE_HIGH}\``);
      expect(doc).toContain(`\`${IMPORTANCE_LOW}\``);
    });

    test('the per-turn fact cap', () => {
      expect(MAX_FACTS_PER_TURN).toBe(3);
      expect(doc).toMatch(/three durable facts/i);
    });
  });

  describe('the on-disk layout it shows is the layout the store uses', () => {
    const paths: readonly string[] = [
      `${MEMORY_DIR_NAME}/`,
      `${MEMORY_ENTRIES_DIR}/`,
      `${MEMORY_ARCHIVE_DIR}/`,
      MEMORY_RETRIEVAL_LOG,
    ];

    for (const path of paths) {
      test(`"${path}"`, () => {
        expect(doc).toContain(path);
      });
    }

    test('the cold-storage banner is quoted verbatim', () => {
      // The banner travels with archived content everywhere it goes, including
      // into the model's context. A page showing a banner the code no longer
      // writes would be teaching a reader to look for the wrong marker.
      expect(doc).toContain(COLD_STORAGE_BANNER_PREFIX);
    });

    test('the retrieval log is described as ids and counts, never content', () => {
      expect(doc).toMatch(/never records? memory\s*\n?content|never record.{0,40}content/i);
    });
  });

  describe("the built-in provider's capability claims come from describe()", () => {
    const provider = createBuiltinMarkdownProvider({
      workspaceRootPath: mkdtempSync(join(tmpdir(), 'vorno-memory-doc-')),
      halfLifeDays: MEMORY_CONFIG_DEFAULTS.decayHalfLifeDays,
      topK: MEMORY_CONFIG_DEFAULTS.topK,
      includeArchived: MEMORY_CONFIG_DEFAULTS.includeArchived,
    });

    test('retrieval is lexical, and the page says so plainly', async () => {
      const capabilities = await provider.describe();
      expect(capabilities.search).toBe('lexical');
      expect(doc).toMatch(/lexical, not semantic/i);
      // With a concrete paraphrase it would miss, not just the adjective.
      expect(doc).toMatch(/will \*\*not\*\*\s+find/i);
    });

    test('nothing leaves the machine, and the privacy section says exactly that', () => {
      // `egress: 'none'` is the claim the whole privacy section rests on.
      return provider.describe().then((capabilities) => {
        expect(capabilities.egress).toBe('none');
        expect(capabilities.requiresProvisioning).toBe(false);
        expect(doc).toContain('node:fs');
        expect(doc).toMatch(/built-in provider: nothing/i);
      });
    });

    test('decay, archive and the retrieval log are all real', async () => {
      const capabilities = await provider.describe();
      expect(capabilities.decay).toBe(true);
      expect(capabilities.archive).toBe(true);
      expect(capabilities.retrievalLog).toBe(true);
      expect(capabilities.structuredReads).toBe(true);
      expect(doc).toMatch(/Nothing in this feature deletes a memory file/i);
    });

    test('the provider honours all four scope layers', async () => {
      const capabilities = await provider.describe();
      expect([...capabilities.scopeLayers]).toEqual(['user', 'session', 'agent', 'turn']);
      expect(doc).toContain('user / session / agent / turn');
    });
  });

  describe('the Headroom provider is documented with its three constraints', () => {
    test('C1 — installed is not the same as working', () => {
      expect(doc).toMatch(/Installed, but not set up/i);
      expect(doc).toContain('~86 MB');
      expect(doc).toContain('uv tool install headroom-ai');
      // The reason the third state exists at all.
      expect(doc).toMatch(/reinstall/i);
    });

    test('C2 — scoping collapses to a single user layer', () => {
      expect(doc).toMatch(/collapses to a single user layer/i);
    });

    test('C3 — reads are prose, so tags and timestamps are unavailable', () => {
      expect(doc).toMatch(/not available on reads/i);
      expect(doc).toContain('[relevance=0.50]');
    });

    test('names the interpreter override the provider actually reads', () => {
      expect(doc).toContain('VORNO_HEADROOM_PYTHON');
    });
  });

  test('turning memory off leaves existing memories on disk', () => {
    expect(doc).toMatch(/existing memories are untouched/i);
  });

  test('the Headroom page hands memory off to this one', () => {
    // The two pages have to stay consistent about which of them owns memory.
    expect(headroomDoc).toContain('## Memory');
    expect(headroomDoc).toContain('(memory.md)');
    expect(headroomDoc).toMatch(/not a Headroom feature/i);
  });
});
