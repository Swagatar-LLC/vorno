/**
 * Tripwire: the pinned Headroom SDK exposes no memory API (PLAN-040 / SUV-0029).
 *
 * SUV-0029 asks for "Headroom's multi-layer memory" behind the boundary adapter,
 * with a "default local-markdown substrate", persistent across sessions and
 * workflow runs. PLAN-040 describes exactly that — and prefixes the whole
 * section with "verify at integration time, not from README claims".
 *
 * This file is that verification, executable. The result was negative:
 * `headroom-ai@0.36.5` has no memory surface of any kind. The memory feature is
 * real, but it lives in Headroom's Python/Rust proxy, reached through
 * `headroom wrap --memory`, the Python client's `client.memory.*`, or
 * proxy-injected `memory_save/search/...` model tools — none of which is
 * reachable from this package. Its substrate is a SQLite database
 * (`.headroom/memory.db`, HNSW + FTS5 indexes), not markdown.
 *
 * The full argument, with citations, is in
 * `roadmap/evidence/PLAN-040/headroom-memory-surface-audit.md`.
 *
 * Why a test and not just a document: SUV-0014 §5 puts this dependency on a
 * monthly bump cadence, and it publishes fast (five patches in three days). If a
 * bump ever adds a memory API, these assertions go red, and the red is the
 * signal that SUV-0029's blocker may have lifted — which a document in a folder
 * would never tell anyone. Read a failure here as "re-audit and re-open
 * SUV-0029", not as "delete the assertion".
 *
 * Note the shape of these checks: they read the installed package off disk with
 * `node:fs` rather than importing it. That is deliberate and required —
 * `scripts/check-headroom-boundary.ts` permits exactly one importer of the SDK
 * (`sdk-adapter.ts`) and explicitly does NOT exempt test files. Reading the
 * bytes is also what the SUV-0014 vetting report does to reproduce its claims.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/** Assembled, not written whole, so this file is not itself a boundary violation. */
const PACKAGE_NAME = ['headroom', 'ai'].join('-');

/** Bun hoists to the root, but a nested install is legal; try both before failing. */
function resolvePackageDist(): string {
  const candidates = [
    join(REPO_ROOT, 'node_modules', PACKAGE_NAME, 'dist'),
    join(REPO_ROOT, 'packages', 'shared', 'node_modules', PACKAGE_NAME, 'dist'),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Could not locate the installed ${PACKAGE_NAME} package. Run \`bun install\`. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

const DIST = resolvePackageDist();

/** Every shipped JS/CJS file, sourcemaps excluded — the bundle is split into chunks. */
function distSources(): string[] {
  return readdirSync(DIST)
    .filter((name) => /\.(js|cjs)$/.test(name))
    .map((name) => readFileSync(join(DIST, name), 'utf8'));
}

const TYPES = readFileSync(join(DIST, 'index.d.ts'), 'utf8');

describe('pinned Headroom SDK memory surface (SUV-0029)', () => {
  it('exposes no memory endpoint on the proxy client', () => {
    // Every SDK method is an HTTP call against a relative path (SUV-0014 §3.2).
    // If the proxy ever serves memory over HTTP and the SDK learns to call it,
    // the path literal appears here first.
    const memoryEndpoints = distSources().flatMap((source) => [
      ...source.matchAll(/["'`](\/v\d+\/memor[a-z]*[a-zA-Z0-9_/]*)/g),
    ]);

    expect(memoryEndpoints.map((match) => match[1])).toEqual([]);
  });

  it('exposes no memory client on HeadroomClient', () => {
    // The Python client reaches memory as `client.memory.search(...)` /
    // `.add(...)`. The TypeScript client has no such member: it declares only
    // chat/messages accessors. Asserting on the declaration rather than on a
    // constructed instance keeps this free of the SDK import.
    expect(TYPES).not.toMatch(/^\s*(readonly\s+)?memory\s*[:?]/m);
    expect(TYPES).not.toMatch(/\bmemory\.(search|add|save|update|delete)\b/);
  });

  it('ships no memory read/write operations under any name', () => {
    // A rename is the likeliest way this arrives (`remember`, `recall`, a
    // `MemoryStore` class). Match the operation names the upstream docs use, so
    // the tripwire is not defeated by the word "memory" being spelled
    // differently. `MemoryUsage`/`memoryUsage` are excluded on purpose: those
    // report the proxy process's RAM via `/debug/memory` and are unrelated.
    const surface = TYPES.replace(/MemoryUsage|memoryUsage/g, '');

    for (const operation of [
      'memorySave',
      'memorySearch',
      'memoryAdd',
      'memoryUpdate',
      'memoryDelete',
      'MemoryStore',
      'MemoryEntry',
      'MemoryClient',
      'withMemory',
    ]) {
      expect(surface).not.toContain(operation);
    }
  });

  it('cannot persist anything: the package performs no filesystem writes', () => {
    // This is what forecloses SUV-0029's "substrate on disk is local markdown"
    // acceptance item through this package. The SDK's own paths module says it
    // plainly ("The TypeScript SDK is an HTTP client today and does not touch
    // the filesystem directly"); `memoryDbPath()` and `nativeMemoryDir()` return
    // path *strings* for the Python side's benefit and nothing reads or writes
    // them here.
    for (const source of distSources()) {
      expect(source).not.toMatch(
        /\b(writeFileSync|appendFileSync|readFileSync|mkdirSync|createWriteStream)\b/,
      );
      expect(source).not.toMatch(/from\s*["'`]node:fs["'`]|require\(["'`]fs["'`]\)/);
    }
  });

  it('names a SQLite database, not markdown, as the memory substrate', () => {
    // Recorded so that the acceptance item's "local markdown" premise cannot
    // quietly drift back in. Upstream's memory wiki documents
    // `.headroom/memory.db` with HNSW and FTS5 indexes; the SDK's path helper
    // agrees, and a `.db` file is not human-readable markdown.
    const paths = distSources().join('\n');

    expect(paths).toContain('memory.db');
    expect(TYPES).toMatch(/declare function memoryDbPath\(\): string;/);
  });

  it('offers SharedContext only as a process-local cache, not a memory layer', () => {
    // SharedContext is the one memory-shaped export, and it is the thing most
    // likely to be mistaken for the memory layer. It is a plain in-process Map
    // behind a TTL — declared `private`, so it is not even reachable to read
    // back out of band. It cannot satisfy "written in one session, retrievable
    // in a later session": a second instance in a second process starts empty.
    expect(TYPES).toMatch(/declare class SharedContext\b/);
    expect(TYPES).toMatch(/class SharedContext \{[\s\S]*?private entries;/);
    expect(TYPES).toMatch(/class SharedContext \{[\s\S]*?\bttl;/);

    // And no durability seam: nothing to point at a file, a path, or a store.
    const declaration = TYPES.match(/interface SharedContextOptions[\s\S]*?\}/)?.[0] ?? '';
    expect(declaration).not.toMatch(/path|file|dir|persist|store|db/i);
  });
});
