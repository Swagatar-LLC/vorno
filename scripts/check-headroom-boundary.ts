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

/**
 * The Python module that serves Headroom's memory over stdio (SUV-0029).
 *
 * Assembled rather than written whole, for the same reason as
 * {@link HEADROOM_PACKAGE}: so this script's own source is not a violation of
 * the rule it enforces.
 */
export const HEADROOM_MEMORY_MODULE = ['headroom', 'memory', 'mcp_server'].join('.');

/**
 * The one file allowed to spawn it.
 *
 * ## Why this second pattern exists
 *
 * The import gate above matches package *imports*. It is therefore structurally
 * blind to a subprocess: `python -m headroom.memory.mcp_server` spawned from any
 * file in the repo is invisible to it, because no module is imported. Until
 * SUV-0029 that blindness cost nothing, since nothing spawned Headroom. SUV-0029
 * is precisely the change that introduces a non-import path to Headroom — so it
 * is also the change that has to close the hole, or the boundary would hold in
 * one direction only while appearing to hold in both.
 *
 * The failure this prevents is concrete: a call site that shells out to
 * Headroom's memory server directly would bypass the provider seam entirely,
 * hardcoding one vendor's three constraints (C1/C2/C3) at a call site that
 * `describe()` exists to keep them out of — which is the exact shape ADR-0031
 * was written to prevent.
 */
export const MEMORY_SUBPROCESS_BOUNDARY_FILES: readonly string[] = [
  'packages/shared/src/memory/headroom-mcp-provider.ts',
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

/**
 * Matches a reference to the memory subprocess module in any spawn-ish shape:
 * `'headroom.memory.mcp_server'`, `["headroom","memory","mcp_server"]` joined,
 * or the bare dotted path in an argv array.
 *
 * Two alternatives, because the string can legitimately be written either whole
 * or assembled — and a gate that only catches the literal teaches the next
 * author to assemble it, which is the wrong lesson. The assembled form is
 * matched by looking for the three segments as adjacent quoted strings.
 */
function memoryModulePattern(): RegExp {
  const [a, b, c] = HEADROOM_MEMORY_MODULE.split('.');
  return new RegExp(
    `${a}\\.${b}\\.${c}` +
      `|['"\`]${a}['"\`]\\s*,\\s*['"\`]${b}['"\`]\\s*,\\s*['"\`]${c}['"\`]`,
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

/**
 * Find every file that names Headroom's memory subprocess and is not the
 * memory boundary (SUV-0029).
 *
 * Same shape as {@link findBoundaryViolations} — deliberately, so the two
 * halves of the boundary are enforced by code that reads the same way rather
 * than by one real gate and one afterthought.
 */
export function findMemorySubprocessViolations(
  repoRoot: string,
  roots: readonly string[] = DEFAULT_ROOTS,
  allowed: readonly string[] = MEMORY_SUBPROCESS_BOUNDARY_FILES,
): string[] {
  const pattern = memoryModulePattern();
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

/** Memory-boundary allowlist entries that no longer name the subprocess. */
export function findStaleMemoryBoundaryEntries(
  repoRoot: string,
  allowed: readonly string[] = MEMORY_SUBPROCESS_BOUNDARY_FILES,
): string[] {
  const pattern = memoryModulePattern();
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
  const memoryStale = findStaleMemoryBoundaryEntries(repoRoot);
  const memoryViolations = findMemorySubprocessViolations(repoRoot);

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

  if (memoryStale.length > 0) {
    console.error(
      `✗ Headroom boundary gate: allowlisted memory boundary file(s) no longer reference ${HEADROOM_MEMORY_MODULE}:`,
    );
    for (const file of memoryStale) console.error(`    ${file}`);
    console.error(
      '\n  Either the memory provider moved (update MEMORY_SUBPROCESS_BOUNDARY_FILES\n' +
        '  in this script) or it was removed (then PLAN-040 SUV-0029 needs revisiting).',
    );
  }

  if (memoryViolations.length > 0) {
    console.error(
      `✗ Headroom boundary gate: ${memoryViolations.length} file(s) reference ${HEADROOM_MEMORY_MODULE} outside the memory boundary:`,
    );
    for (const file of memoryViolations) console.error(`    ${file}`);
    console.error(
      `\n  Only ${MEMORY_SUBPROCESS_BOUNDARY_FILES.join(', ')} may spawn Headroom's\n` +
        '  memory server. Everything else goes through the vendor-neutral seam:\n' +
        "    import { createMemoryProvider } from '@craft-agent/shared/memory'\n" +
        '  See ADR-0031 and packages/core/src/types/memory-provider.ts.',
    );
  }

  if (
    stale.length > 0 ||
    violations.length > 0 ||
    memoryStale.length > 0 ||
    memoryViolations.length > 0
  ) {
    process.exit(1);
  }

  console.log(
    `✓ Headroom boundary gate: ${HEADROOM_PACKAGE} imported only by ${BOUNDARY_FILES.join(', ')}\n` +
      `✓ Headroom memory boundary gate: ${HEADROOM_MEMORY_MODULE} spawned only by ${MEMORY_SUBPROCESS_BOUNDARY_FILES.join(', ')}`,
  );
}
