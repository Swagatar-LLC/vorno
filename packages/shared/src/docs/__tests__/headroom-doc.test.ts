/**
 * The Headroom docs page describes surfaces that actually exist (fork: PLAN-040 / SUV-0032).
 *
 * SUV-0032's third acceptance item is "every UI element the page references
 * exists in the app as described at time of merge". That is true the day the
 * page is written and silently stops being true the first time someone renames a
 * label — and a docs page is the one artifact where nothing fails when it goes
 * stale. Prose rot is invisible; the user finds it, not CI.
 *
 * So the page's factual claims are asserted against their sources rather than
 * left to review:
 *
 *  - **Quoted UI copy** must appear verbatim in `en.json`. The page quotes
 *    control labels, error messages and empty-state sentences; each string here
 *    is checked to be a real value in the shipped locale, so renaming a label
 *    without updating the page reds the build.
 *  - **The privacy section's opt-in claim** — that the base address is pinned to
 *    localhost — is checked against `DEFAULT_HEADROOM_BASE_URL`, the constant
 *    the boundary actually passes to the SDK. That claim is the load-bearing one
 *    on the whole page; it must not be able to drift from the code.
 *  - **The documented default** (Headroom off) is checked against
 *    `HEADROOM_CONFIG_DEFAULTS`, so "off by default" cannot become folklore.
 *
 * Deliberately *not* asserted: that any given sentence is well written, or that
 * the page covers a subject exhaustively. This guards facts, not prose.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADROOM_CONFIG_DEFAULTS } from '@craft-agent/core/types';
import { DEFAULT_HEADROOM_BASE_URL } from '../../headroom/index.ts';
import en from '../../i18n/locales/en.json';

const DOC_PATH = join(
  import.meta.dir,
  '../../../../../apps/electron/resources/docs/headroom.md',
);

const doc = readFileSync(DOC_PATH, 'utf-8');

/**
 * SUV-0025's benchmark report — the source for every measured figure the page
 * quotes in §"What to expect today".
 *
 * Pinning page→report rather than page→literal is deliberate: a figure typed
 * into prose from memory is the exact defect this guard was added to catch. The
 * first version of the page claimed a 12.5% whole-corpus saving and a
 * 1.3–1.8 s p95, neither of which appears anywhere in the report (the measured
 * values are 10.5% and 1.4–2.1 s). Asserting the string is present in BOTH
 * documents means a re-benchmark that moves a number reds the page too.
 */
const BENCHMARK_PATH = join(
  import.meta.dir,
  '../../../../../roadmap/evidence/PLAN-040/headroom-benchmark-report.md',
);

const benchmark = readFileSync(BENCHMARK_PATH, 'utf-8');

/** Every leaf string value in the shipped English locale. */
const localeValues = new Set<string>();
(function collect(node: unknown): void {
  if (typeof node === 'string') {
    localeValues.add(node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) collect(value);
  }
})(en);

/**
 * UI copy the page quotes, grouped by the surface it belongs to.
 *
 * Each entry must be BOTH present in the page and a real value in `en.json`.
 * The two halves catch opposite failures: the first catches a page that stopped
 * documenting a control, the second catches a control that was renamed under a
 * page still describing it by its old name.
 */
const QUOTED_UI_COPY: Record<string, readonly string[]> = {
  // SUV-0017 — the workspace settings toggle and its option fields.
  'settings toggle': [
    'Enable Headroom',
    'Master switch. The other options have no effect while this is off.',
    'Compression engines',
    'Comma-separated engine ids, most preferred first. Empty means no compression.',
    'Verbosity',
    'Expose statistics',
    'Workspace override',
    'Instance default',
  ],
  // SUV-0026 — the view-original affordance and its refusal messages.
  'view-original affordance': [
    'Original, before compression',
    'Headroom is off for this workspace, so the original cannot be retrieved.',
    'The Headroom SDK is not available in this build, so the original cannot be retrieved.',
    'The Headroom service did not answer. The original was not retrieved.',
    'The Headroom service no longer holds this content. The original was not retrieved.',
    'Retrieval failed. The original was not retrieved.',
    'Retrieving compressed originals is not available here.',
  ],
  // SUV-0027 — the savings report, its metrics and its three empty states.
  'savings report': [
    'Headroom savings',
    'Tokens before',
    'Tokens after',
    'Tokens saved',
    'Items compressed',
    'Originals retrieved',
    'This session',
    'This workspace',
    'No statistics available. Turn on Headroom and "Expose statistics" for this workspace.',
    'Nothing has been compressed yet, so there is nothing measured to report.',
    'Headroom is not available here, so nothing was measured.',
  ],
};

describe('Headroom docs page (SUV-0032)', () => {
  test('the page ships in the docs content source', () => {
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('# Headroom');
  });

  test('covers the three subjects the acceptance list names', () => {
    // Enable/disable per workspace, viewing originals, and the savings report.
    expect(doc).toContain('## Turning Headroom on or off');
    expect(doc).toContain('## Seeing what was compressed, and getting the original back');
    expect(doc).toContain('## The savings report');
    expect(doc).toContain('## Privacy: what leaves your machine');
    expect(doc).toMatch(/per workspace/i);
  });

  for (const [surface, strings] of Object.entries(QUOTED_UI_COPY)) {
    describe(`quotes the shipped ${surface} copy`, () => {
      for (const value of strings) {
        test(`"${value}"`, () => {
          // The label exists in the app...
          expect(localeValues).toContain(value);
          // ...and the page still describes it by that name.
          expect(doc).toContain(value);
        });
      }
    });
  }

  test('the base address it names is the one the boundary pins', () => {
    expect(DEFAULT_HEADROOM_BASE_URL).toBe('http://localhost:8787');
    expect(doc).toContain(DEFAULT_HEADROOM_BASE_URL);
    // The privacy claim rests on localhost specifically, not merely on "some
    // configured address".
    expect(new URL(DEFAULT_HEADROOM_BASE_URL).hostname).toBe('localhost');
  });

  test('documents the environment variable Vorno refuses to honour', () => {
    // SUV-0014 finding: the SDK would otherwise read this and silently redirect
    // every compressed payload. If Vorno ever starts honouring it, this page's
    // privacy section becomes false and must be rewritten.
    expect(doc).toContain('HEADROOM_BASE_URL');
  });

  test('names the credentials the boundary keeps out of reach (SUV-0014 F3)', () => {
    expect(doc).toContain('OPENAI_API_KEY');
    expect(doc).toContain('ANTHROPIC_API_KEY');
  });

  test('the "off by default" claim matches the shipped defaults', () => {
    expect(HEADROOM_CONFIG_DEFAULTS.enabled).toBe(false);
    expect(HEADROOM_CONFIG_DEFAULTS.exposeStats).toBe(false);
    expect(HEADROOM_CONFIG_DEFAULTS.compressionEngines).toEqual([]);
    expect(doc).toMatch(/off by default/i);
  });

  describe('every measured figure it quotes is in the benchmark report', () => {
    // Each entry must appear verbatim in BOTH the page and SUV-0025's report.
    const MEASURED_FIGURES: readonly string[] = [
      '10.5%', // best measured whole-corpus saving (`balanced`)
      '1.4–2.1 seconds', // p95 latency, "roughly one call in twenty"
      '0 of 48', // tool outputs accepted in a live session
      '240', // compression calls across which zero handles were issued
      '47,811 bytes', // unrecoverable node output paid for that 10.5%
      '+4.4 to +13.1 ms', // p50 latency cost over the no-op baseline
    ];

    for (const figure of MEASURED_FIGURES) {
      test(`"${figure}"`, () => {
        expect(benchmark).toContain(figure);
        expect(doc).toContain(figure);
      });
    }

    test('quotes no figure the report does not contain', () => {
      // The two figures the first draft interpolated. Named explicitly so the
      // regression cannot come back by a different route than the check above.
      for (const invented of ['12.5%', '1.3–1.8 seconds']) {
        expect(benchmark).not.toContain(invented);
        expect(doc).not.toContain(invented);
      }
    });
  });

  test('claims no memory feature, because the pinned SDK has none', () => {
    // SUV-0029 is blocked on exactly this: there is no memory API to document.
    // A page that grew a memory how-to would be documenting something absent.
    expect(doc).toContain('## Memory');
    expect(doc).toMatch(/not available in Vorno/i);
  });
});
