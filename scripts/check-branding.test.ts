/**
 * Mutation tests for the branding gate (SUV-0061).
 *
 * A gate is only ever observed *passing* on a clean tree, which proves nothing:
 * a rule whose regex never matches, a scan path that was renamed away, or an
 * allowlist entry that quietly swallows a whole surface all look identical to
 * "clean". So each test injects the exact string the gate exists to catch, at a
 * real repo-relative path, and asserts it is reported — and each negative test
 * asserts a legitimate neighbour is not.
 *
 * Content is synthetic and passed in; nothing is written to the tree.
 *
 * Run: bun test scripts/check-branding.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { scanFile, TARGETED_SCANS } from './check-branding.ts';

const PAGES_GUIDE = 'apps/electron/resources/docs/pages.md';
const TOOL_DEFS = 'packages/session-tools-core/src/tool-defs.ts';

const ruleIds = (path: string, content: string) => scanFile(path, content).map((v) => v.ruleId);

describe('upstream endpoints on Pages surfaces', () => {
  test('bundled Pages guide — an upstream publication URL fails', () => {
    // The blanket `apps/electron/resources/` allowlist entry covers the general
    // pass; if it also covered the targeted scan this would silently pass.
    expect(ruleIds(PAGES_GUIDE, 'Publish to https://thecraftagents.com/p/api.')).toContain('upstream-domain');
    expect(ruleIds(PAGES_GUIDE, 'See https://craft.do/docs for more.')).toContain('upstream-domain');
  });

  test('bundled Pages guide — markdown headings and bullets are scanned, not skipped as comments', () => {
    // `#` and `*` are the code-comment heuristics. In markdown they are a
    // heading and a bullet, so applying them would silently exempt most of the
    // guide — the single biggest way this scan could look green and be blind.
    expect(ruleIds(PAGES_GUIDE, '## Publishing to thecraftagents.com')).toContain('upstream-domain');
    expect(ruleIds(PAGES_GUIDE, '* Publish to https://thecraftagents.com/p/api')).toContain('upstream-domain');
    expect(ruleIds(PAGES_GUIDE, '  // const api = "https://craft.do/p/api"')).toContain('upstream-domain');
    // Real markdown comments are still skipped.
    expect(scanFile(PAGES_GUIDE, '<!-- was https://thecraftagents.com/p/api -->')).toEqual([]);
  });

  test('bundled Pages guide — multi-line HTML comments are skipped across every line', () => {
    // The other direction from the heading case: a legacy endpoint commented
    // out over several lines must not fail CI for text no reader ever sees.
    const commented = [
      '<!--',
      'Legacy: publication used to target https://thecraftagents.com/p/api',
      'and the docs lived at https://craft.do/docs',
      '-->',
    ].join('\n');
    expect(scanFile(PAGES_GUIDE, commented)).toEqual([]);
    // The comment must actually close — text after `-->` is visible again.
    expect(ruleIds(PAGES_GUIDE, '<!--\nold\n-->\nPublish to https://thecraftagents.com/p/api')).toContain('upstream-domain');
    // And visible text sharing a line with a comment is still scanned.
    expect(ruleIds(PAGES_GUIDE, '<!-- note --> Publish to https://thecraftagents.com/p/api')).toContain('upstream-domain');
    expect(ruleIds(PAGES_GUIDE, 'Publish to https://craft.do/p/api <!-- fix me -->')).toContain('upstream-domain');
  });

  test('a targeted hit carries the targeted remedy, not the general one', () => {
    // Both passes own `upstream-domain`. A bundled-markdown hit told to "import
    // SERVICE_BASE_URL from the branding module" is unactionable advice.
    const [violation] = scanFile(PAGES_GUIDE, 'Publish to https://thecraftagents.com/p/api.');
    expect(violation?.description).toContain('Pages surface');
    // A file in both passes is reported once, not twice.
    expect(scanFile('packages/shared/src/pages/share-bundle.ts', "const a = 'https://craft.do';")).toHaveLength(1);
  });

  test('bundled Pages guide — the Vorno endpoint and compatibility names pass', () => {
    expect(scanFile(PAGES_GUIDE, 'Publication targets only https://pages.vorno.ai.')).toEqual([]);
    // These are wire/storage contracts, not branding — gating them would be wrong.
    expect(scanFile(PAGES_GUIDE, "if (msg.protocol !== 'craft-pages/v1') return;")).toEqual([]);
    expect(scanFile(PAGES_GUIDE, 'Stored at `pages/{slug}/` with `CRAFT_PAGE_DIR` set.')).toEqual([]);
    expect(scanFile(PAGES_GUIDE, 'import { openPageDataStore } from "@craft-agent/shared/pages/data-store";')).toEqual([]);
  });

  test('Pages code inside server-core fails, even though server-core is out of SCAN_ROOTS', () => {
    const inServerCore = ruleIds(
      'packages/server-core/src/pages/session-executor.ts',
      "const base = 'https://thecraftagents.com/p/api';",
    );
    expect(inServerCore).toContain('upstream-domain');
    // The same string in a non-Pages server-core file stays out of scope: the
    // targeted scan is deliberately narrow and does not annex upstream internals.
    expect(scanFile('packages/server-core/src/sessions/manager.ts', "const base = 'https://thecraftagents.com';")).toEqual([]);
  });

  test('the Vorno publication Worker fails on a Craft endpoint', () => {
    expect(ruleIds('workers/pages/index.js', "const API = 'https://thecraftagents.com/p/api'")).toContain('upstream-domain');
  });

  test('the reviewed legacy-URL exception in the publisher still holds', () => {
    // publisher.ts recognizes the stored legacy public URL so an existing
    // publication stays revocable. It is allowlisted for `upstream-domain`
    // explicitly, so the targeted scan honours it.
    expect(
      scanFile('packages/shared/src/pages/publisher.ts', "if (url.hostname === 'thecraftagents.com') return 'https://thecraftagents.com/p/api';"),
    ).toEqual([]);
    // An unrelated Pages file gets no such exemption.
    expect(ruleIds('packages/shared/src/pages/share-bundle.ts', "const api = 'https://thecraftagents.com/p/api';")).toContain('upstream-domain');
  });
});

describe('upstream config-dir paths in agent-visible text', () => {
  test('a tool description naming the upstream docs dir fails', () => {
    expect(
      ruleIds(TOOL_DEFS, "  content: z.string().describe('Read ~/.craft-agent/docs/pages.md before authoring.'),"),
    ).toContain('upstream-config-dir-path');
  });

  test('every doc under the upstream config dir fails, not just pages.md', () => {
    expect(ruleIds(TOOL_DEFS, "suggestion: 'See ~/.craft-agent/docs/mermaid.md'")).toContain('upstream-config-dir-path');
  });

  test('the system prompt and the Claude-side description registry are covered', () => {
    expect(
      ruleIds('packages/shared/src/prompts/system.ts', '| Pages | `~/.craft-agent/docs/pages.md` | BEFORE creating Pages |'),
    ).toContain('upstream-config-dir-path');
    expect(
      ruleIds('packages/shared/src/agent/session-scoped-tools.ts', "create_page: BASE + '~/.craft-agent/docs/pages.md',"),
    ).toContain('upstream-config-dir-path');
  });

  test('the resolved DOC_REFS path and the migration-source contract pass', () => {
    expect(scanFile(TOOL_DEFS, '`${DOC_REFS.pages}`')).toEqual([]);
    expect(scanFile(TOOL_DEFS, "const guide = '~/.vorno-agent/docs/pages.md';")).toEqual([]);
    // `~/.craft-agent` as a config-dir *identity* (migration source, workspace
    // path) is a compatibility contract; only the dead `/docs/` pointer is gated.
    expect(scanFile(TOOL_DEFS, "const dir = process.env.CRAFT_CONFIG_DIR ?? '~/.craft-agent';")).toEqual([]);
  });

  test('comment lines are still skipped — the heuristic is unchanged', () => {
    expect(scanFile(TOOL_DEFS, '// Absolute path to ~/.craft-agent/docs/pages.md')).toEqual([]);
    expect(scanFile(TOOL_DEFS, ' * @param p - e.g. ~/.craft-agent/docs/pages.md')).toEqual([]);
  });
});

describe('scan wiring', () => {
  test('test files are skipped so fixtures cannot trip the gate', () => {
    expect(scanFile('packages/shared/src/pages/publisher.test.ts', "'https://thecraftagents.com/p/api'")).toEqual([]);
  });

  test('root markdown stays unscanned — attribution notices are required, not violations', () => {
    expect(scanFile('README.md', 'A fork of Craft Agents, see https://thecraftagents.com.')).toEqual([]);
  });

  test('every targeted scan path still exists in the tree', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const repoRoot = join(import.meta.dir, '..');
    for (const scan of TARGETED_SCANS) {
      for (const p of scan.paths) {
        expect(existsSync(join(repoRoot, p)), `${scan.ruleId} path missing: ${p}`).toBe(true);
      }
    }
  });
});
