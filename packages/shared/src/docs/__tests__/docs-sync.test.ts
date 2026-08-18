/**
 * Docs sync: subdirectory guides reach the user's docs dir, and stale ones leave.
 *
 * Both halves are load-bearing and neither is observable from a build:
 *
 *  - `loadBundledDocs` used to be a flat `readdirSync` + `readFileSync`. A
 *    subdirectory hit `readFileSync` on a directory, threw EISDIR, and was
 *    swallowed into a `console.error` — so `sources/*.md` would ship inside the
 *    app, never appear in `~/.vorno-agent/docs/`, and the only symptom would be
 *    the agent failing to Read a guide the repo plainly contains.
 *  - The sync is otherwise write-only, so a guide renamed or deleted upstream
 *    would linger forever. A setup guide naming a retired endpoint is worse than
 *    no guide: the agent follows it confidently until it fails at credential time.
 *
 * The prune is deliberately scoped to `docs/sources/`. This test pins that scope —
 * an unrelated file at the top level of the docs dir must survive, because users
 * can put their own files there and a blanket prune would be silent data loss.
 *
 * `initializeDocs()` is once-per-process (module-level `docsInitialized` plus a
 * lazy `_bundledDocs` cache), and in a full `bun test` run `config/storage.ts`
 * has already called it — so this resets those guards first and makes every
 * assertion in one test. Without the reset it passes in isolation and silently
 * no-ops in CI, which is worse than having no test.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setBundledAssetsRoot } from '../../utils/paths.ts';
import { initializeDocs, getDocsDir, DOC_REFS, resetDocsSyncForTests } from '../index.ts';

describe('bundled docs sync', () => {
  test('syncs subdirectory guides and prunes only stale ones under sources/', () => {
    resetDocsSyncForTests();

    // Bundle: one top-level doc and two service guides in a subdirectory.
    const assetsRoot = mkdtempSync(join(tmpdir(), 'vorno-docs-assets-'));
    const bundledDocs = join(assetsRoot, 'resources', 'docs');
    mkdirSync(join(bundledDocs, 'sources'), { recursive: true });
    writeFileSync(join(bundledDocs, 'sources.md'), '# Sources workflow', 'utf-8');
    writeFileSync(join(bundledDocs, 'sources', 'github.md'), '# GitHub', 'utf-8');
    writeFileSync(join(bundledDocs, 'sources', 'linear.md'), '# Linear', 'utf-8');
    setBundledAssetsRoot(assetsRoot);

    // Pre-seed the destination as a previous version would have left it:
    // a service guide that is no longer bundled, plus a file the user put at the
    // top level themselves.
    const docsDir = getDocsDir();
    mkdirSync(join(docsDir, 'sources'), { recursive: true });
    writeFileSync(join(docsDir, 'sources', 'retired-service.md'), '# Retired', 'utf-8');
    writeFileSync(join(docsDir, 'my-own-notes.md'), 'user content', 'utf-8');

    initializeDocs();

    // Subdirectory guides land, with their content, at the nested path.
    expect(existsSync(join(docsDir, 'sources', 'github.md'))).toBe(true);
    expect(readFileSync(join(docsDir, 'sources', 'github.md'), 'utf-8')).toBe('# GitHub');
    expect(existsSync(join(docsDir, 'sources', 'linear.md'))).toBe(true);

    // Top-level docs still sync.
    expect(existsSync(join(docsDir, 'sources.md'))).toBe(true);

    // A guide that is no longer bundled is removed...
    expect(existsSync(join(docsDir, 'sources', 'retired-service.md'))).toBe(false);

    // ...but the prune does not reach outside sources/.
    expect(existsSync(join(docsDir, 'my-own-notes.md'))).toBe(true);
    expect(readFileSync(join(docsDir, 'my-own-notes.md'), 'utf-8')).toBe('user content');
  });

  test('DOC_REFS points at the guides directory, not at individual services', () => {
    // The system prompt loads this table on every turn. Referencing the directory
    // keeps ~16 service guides out of every request; the agent lists it when it is
    // actually setting up a source.
    expect(DOC_REFS.sourceGuides).toEndWith('/docs/sources/');
  });
});
