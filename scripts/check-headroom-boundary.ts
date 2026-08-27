#!/usr/bin/env bun
/**
 * Headroom boundary gate (PLAN-040 / SUV-0015) — fails CI if any file outside
 * the boundary module imports the Headroom SDK directly.
 *
 * Vorno integrates Headroom; it does not marry it. The whole value of the
 * boundary is that an SDK upgrade, a swap to the proxy or MCP surface, or
 * removing Headroom altogether is a change to ONE file. That property is worth
 * nothing if a call site can quietly `import { HeadroomClient } from
 * 'headroom-ai'` next quarter, and code review does not reliably catch a single
 * added import line. This gate does.
 *
 * It replaces the "is imported by no production source file" guard that
 * SUV-0014 landed in `packages/shared/src/__tests__/headroom-pin.test.ts` — that
 * one asserted *zero* importers because the dependency was landed unreferenced.
 * The successor asserts *exactly one*, which is the invariant from here on.
 *
 * Test files are NOT exempt. A test that imports the SDK directly is a test that
 * can keep passing while the boundary rots underneath it; the round-trip suite
 * goes through the adapter like everything else.
 *
 * Deliberately dependency-free (node built-ins only) so the CI job needs no
 * `bun install`, matching `scripts/check-branding.ts`.
 *
 * Usage: bun run scripts/check-headroom-boundary.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The SDK package name, assembled rather than written whole so this script's own source is not a violation of the rule it enforces. */
export const HEADROOM_PACKAGE = ['headroom', 'ai'].join('-');

/**
 * The one file allowed to import it, repo-relative and POSIX-separated.
 *
 * Changing this list is the review checkpoint: a second entry means the seam
 * has two owners, which is the failure mode the gate exists to prevent.
 */
export const BOUNDARY_FILES: readonly string[] = [
  'packages/shared/src/headroom/sdk-adapter.ts',
];

/** Roots that ship to users. `scripts/` is excluded — this file lives there. */
const DEFAULT_ROOTS = ['apps', 'packages'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage']);
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Matches a real import of the package or any of its subpaths:
 *   `from 'headroom-ai'`, `require("headroom-ai")`, `import('headroom-ai/openai')`
 * and not the bare name in prose or in a string constant.
 */
function importPattern(): RegExp {
  return new RegExp(
    `(from|require\\(|import\\()\\s*['"\`]${HEADROOM_PACKAGE}(/[^'"\`]*)?['"\`]`,
  );
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);

    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (isDir) collectSourceFiles(full, acc);
    else if (SOURCE_EXTS.some((ext) => entry.endsWith(ext))) acc.push(full);
  }

  return acc;
}

/**
 * Find every file under `roots` that imports the SDK and is not the boundary.
 *
 * Exported so the gate itself is unit-testable against a fixture tree — a guard
 * nobody has watched fail is a guard nobody knows works.
 *
 * @param repoRoot Absolute path the returned paths are relative to.
 * @param roots Directory names under `repoRoot` to scan.
 * @param allowed Repo-relative POSIX paths permitted to import the SDK.
 */
export function findBoundaryViolations(
  repoRoot: string,
  roots: readonly string[] = DEFAULT_ROOTS,
  allowed: readonly string[] = BOUNDARY_FILES,
): string[] {
  const pattern = importPattern();
  const allowedSet = new Set(allowed);

  return roots
    .flatMap((root) => collectSourceFiles(join(repoRoot, root)))
    .filter((file) => {
      let contents: string;
      try {
        contents = readFileSync(file, 'utf8');
      } catch {
        return false;
      }
      if (!pattern.test(contents)) return false;
      return !allowedSet.has(relative(repoRoot, file).split(sep).join('/'));
    })
    .map((file) => relative(repoRoot, file).split(sep).join('/'))
    .sort();
}

/**
 * Boundary files that no longer exist, or exist but no longer import the SDK.
 *
 * A stale allowlist entry is the quiet way this gate stops meaning anything: if
 * the boundary is renamed, every scanned file becomes "not the boundary" and the
 * gate passes on a codebase with no boundary at all.
 */
export function findStaleBoundaryEntries(
  repoRoot: string,
  allowed: readonly string[] = BOUNDARY_FILES,
): string[] {
  const pattern = importPattern();
  return allowed
    .filter((rel) => {
      try {
        return !pattern.test(readFileSync(join(repoRoot, rel), 'utf8'));
      } catch {
        return true;
      }
    })
    .sort();
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, '..');

  const stale = findStaleBoundaryEntries(repoRoot);
  const violations = findBoundaryViolations(repoRoot);

  if (stale.length > 0) {
    console.error(
      `✗ Headroom boundary gate: allowlisted boundary file(s) no longer import ${HEADROOM_PACKAGE}:`,
    );
    for (const file of stale) console.error(`    ${file}`);
    console.error(
      '\n  Either the boundary moved (update BOUNDARY_FILES in this script) or it\n' +
        '  was deleted (then this gate, and PLAN-040 SUV-0015, need revisiting).',
    );
  }

  if (violations.length > 0) {
    console.error(
      `✗ Headroom boundary gate: ${violations.length} file(s) import ${HEADROOM_PACKAGE} outside the boundary:`,
    );
    for (const file of violations) console.error(`    ${file}`);
    console.error(
      `\n  Only ${BOUNDARY_FILES.join(', ')} may import the SDK.\n` +
        "  Everything else uses the HeadroomAdapter contract:\n" +
        "    import { createHeadroomAdapter } from '@craft-agent/shared/headroom'\n" +
        '  See roadmap/suvs/ SUV-0015 and packages/core/src/types/headroom-adapter.ts.',
    );
  }

  if (stale.length > 0 || violations.length > 0) process.exit(1);

  console.log(
    `✓ Headroom boundary gate: ${HEADROOM_PACKAGE} imported only by ${BOUNDARY_FILES.join(', ')}`,
  );
}
