/**
 * Docs sync: what this build ships reaches the user's docs dir, and what it no
 * longer ships leaves — while user-authored docs and a bad manifest are safe.
 *
 * All three halves are load-bearing and none is observable from a build:
 *
 *  - `loadBundledDocs` used to be a flat `readdirSync` + `readFileSync`. A
 *    subdirectory hit `readFileSync` on a directory, threw EISDIR, and was
 *    swallowed into a `console.error` — so `sources/*.md` would ship inside the
 *    app, never appear in `~/.vorno-agent/docs/`, and the only symptom would be
 *    the agent failing to Read a guide the repo plainly contains.
 *  - The sync would otherwise be write-only, so a guide renamed or dropped in a
 *    later build lingers forever from an earlier install. A setup guide naming a
 *    retired endpoint is worse than no guide: the agent follows it confidently
 *    until it fails at credential time. The reconcile deletes what the build no
 *    longer ships — recursively, so a renamed top-level doc goes too, not just a
 *    stale `sources/<service>.md`.
 *  - Deleting user-visible files is the part to get right. The reconcile runs
 *    against the shipped manifest, never a wildcard, and leaves the `local/`
 *    namespace untouched — so an empty or partially-read manifest can never wipe
 *    the directory, and offline/power-user copies survive every upgrade.
 *
 * `initializeDocs()` is once-per-process (module-level `docsInitialized` plus a
 * lazy cache), and in a full `bun test` run `config/storage.ts` has already
 * called it — so each test resets those guards AND wipes the shared docs dir
 * first. Without the reset a docs test passes in isolation and silently no-ops
 * in CI, which is worse than having no test.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setBundledAssetsRoot } from '../../utils/paths.ts';
import { initializeDocs, getDocsDir, DOC_REFS, resetDocsSyncForTests } from '../index.ts';

/** Point the sync at a fresh, empty bundled-assets dir and return its docs root. */
function freshAssetsDir(): string {
  const assetsRoot = mkdtempSync(join(tmpdir(), 'vorno-docs-assets-'));
  const bundledDocs = join(assetsRoot, 'resources', 'docs');
  mkdirSync(bundledDocs, { recursive: true });
  setBundledAssetsRoot(assetsRoot);
  return bundledDocs;
}

describe('bundled docs sync', () => {
  beforeEach(() => {
    // Fresh process-guard state AND a clean shared docs dir (CONFIG_DIR/docs is
    // fixed per process — a tmpdir under the test config fixture, safe to wipe).
    resetDocsSyncForTests();
    rmSync(getDocsDir(), { recursive: true, force: true });
  });

  test('writes shipped docs, prunes stale ones (top-level and sources/), keeps local/', () => {
    const bundledDocs = freshAssetsDir();
    mkdirSync(join(bundledDocs, 'sources'), { recursive: true });
    writeFileSync(join(bundledDocs, 'sources.md'), '# Sources workflow', 'utf-8');
    writeFileSync(join(bundledDocs, 'sources', 'github.md'), '# GitHub', 'utf-8');
    writeFileSync(join(bundledDocs, 'sources', 'linear.md'), '# Linear', 'utf-8');

    // Pre-seed the destination as a previous version would have left it: a stale
    // service guide, a stale *top-level* doc (a since-renamed guide), and files
    // the user put under the protected local/ namespace.
    const docsDir = getDocsDir();
    mkdirSync(join(docsDir, 'sources'), { recursive: true });
    mkdirSync(join(docsDir, 'local', 'nested'), { recursive: true });
    writeFileSync(join(docsDir, 'sources', 'retired-service.md'), '# Retired', 'utf-8');
    writeFileSync(join(docsDir, 'craft-cli.md'), '# old name', 'utf-8');
    writeFileSync(join(docsDir, 'local', 'my-own-notes.md'), 'user content', 'utf-8');
    writeFileSync(join(docsDir, 'local', 'nested', 'deep.md'), 'deep user content', 'utf-8');

    initializeDocs();

    // Shipped docs land, with content, at top level and the nested path.
    expect(readFileSync(join(docsDir, 'sources.md'), 'utf-8')).toBe('# Sources workflow');
    expect(readFileSync(join(docsDir, 'sources', 'github.md'), 'utf-8')).toBe('# GitHub');
    expect(existsSync(join(docsDir, 'sources', 'linear.md'))).toBe(true);

    // Anything the build no longer ships is removed — at every level.
    expect(existsSync(join(docsDir, 'sources', 'retired-service.md'))).toBe(false);
    expect(existsSync(join(docsDir, 'craft-cli.md'))).toBe(false);

    // The user's local/ namespace is untouched, at every depth.
    expect(readFileSync(join(docsDir, 'local', 'my-own-notes.md'), 'utf-8')).toBe('user content');
    expect(readFileSync(join(docsDir, 'local', 'nested', 'deep.md'), 'utf-8')).toBe('deep user content');
  });

  test('an emptied-out subdirectory is removed once its guides are gone', () => {
    const bundledDocs = freshAssetsDir();
    // This build ships only a top-level doc — no sources/ at all.
    writeFileSync(join(bundledDocs, 'sources.md'), '# Sources', 'utf-8');

    const docsDir = getDocsDir();
    mkdirSync(join(docsDir, 'sources'), { recursive: true });
    writeFileSync(join(docsDir, 'sources', 'github.md'), '# GitHub', 'utf-8');

    initializeDocs();

    expect(existsSync(join(docsDir, 'sources', 'github.md'))).toBe(false);
    // The now-empty directory should not linger.
    expect(existsSync(join(docsDir, 'sources'))).toBe(false);
  });

  test('an EMPTY manifest never deletes anything (broken/missing bundle guard)', () => {
    freshAssetsDir(); // assets dir exists but ships zero docs

    const docsDir = getDocsDir();
    mkdirSync(join(docsDir, 'sources'), { recursive: true });
    writeFileSync(join(docsDir, 'sources', 'github.md'), '# GitHub', 'utf-8');
    writeFileSync(join(docsDir, 'sources.md'), '# Sources', 'utf-8');

    initializeDocs();

    // Empty manifest is treated as a broken read, not a build that ships nothing:
    // the existing docs must all survive.
    expect(existsSync(join(docsDir, 'sources', 'github.md'))).toBe(true);
    expect(existsSync(join(docsDir, 'sources.md'))).toBe(true);
  });

  test('a PARTIALLY-read manifest never deletes anything', () => {
    const bundledDocs = freshAssetsDir();
    writeFileSync(join(bundledDocs, 'sources.md'), '# Sources', 'utf-8');
    mkdirSync(join(bundledDocs, 'sources'), { recursive: true });
    writeFileSync(join(bundledDocs, 'sources', 'github.md'), '# GitHub', 'utf-8');
    // A doc two levels deep can't become a manifest key — loadBundledDocs flags
    // the manifest incomplete rather than silently dropping shipped content, and
    // an incomplete manifest must delete nothing.
    mkdirSync(join(bundledDocs, 'sources', 'nested'), { recursive: true });
    writeFileSync(join(bundledDocs, 'sources', 'nested', 'buried.md'), '# Buried', 'utf-8');

    const docsDir = getDocsDir();
    mkdirSync(join(docsDir, 'sources'), { recursive: true });
    writeFileSync(join(docsDir, 'sources', 'retired-service.md'), '# Retired', 'utf-8');

    initializeDocs();

    // Reconcile skipped: the stale guide that a complete run would prune survives.
    expect(existsSync(join(docsDir, 'sources', 'retired-service.md'))).toBe(true);
  });

  test('DOC_REFS points at the guides directory, not at individual services', () => {
    // The system prompt loads this table on every turn. Referencing the directory
    // keeps ~16 service guides out of every request; the agent lists it when it is
    // actually setting up a source.
    expect(DOC_REFS.sourceGuides).toEndWith('/docs/sources/');
  });
});
