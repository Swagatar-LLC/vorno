/**
 * The memory half of the Headroom boundary gate (fork: PLAN-040 / SUV-0029).
 *
 * SUV-0029's second acceptance item requires the gate to catch the **subprocess**
 * seam as well as package imports, and to be "proven able to go red on a
 * mutation". The second half is the part that matters: a gate nobody has
 * watched fail is a gate nobody knows works, and this one is easy to write
 * vacuously — a regex that matches nothing passes on every codebase forever.
 *
 * Why the gate needed a second pattern at all: the original matches `import` /
 * `require` of the Headroom npm package. It is therefore structurally blind to
 * a subprocess, because spawning the Python memory module with `python -m`
 * imports nothing. This SUV is the one that introduced a non-import path to
 * Headroom, so it is the one that had to close the hole.
 *
 * Violating strings are assembled at runtime throughout, and the module path is
 * never spelled out even in prose, because the gate is a plain-text scan that
 * deliberately exempts neither comments nor test files. Both of those rules
 * caught this very file while it was being written.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HEADROOM_MEMORY_MODULE,
  MEMORY_SUBPROCESS_BOUNDARY_FILES,
  findMemorySubprocessViolations,
  findStaleMemoryBoundaryEntries,
} from '../../../../../scripts/check-headroom-boundary.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/**
 * The module path, built from a pipe-delimited source string.
 *
 * Note the indirection: the obvious spelling — a three-element array literal of
 * quoted segments — is itself matched by the gate's assembled-form pattern, and
 * this file caught itself the first time it ran. That is a small, welcome proof
 * that the second pattern is not vacuous, and the reason the parts are split
 * out of one string here rather than written as adjacent literals.
 */
const PARTS = 'headroom|memory|mcp_server'.split('|');
const DOTTED = PARTS.join('.');
/** The assembled-argv form, likewise built at runtime. */
const ARGV = `[${PARTS.map((part) => `'${part}'`).join(', ')}]`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vorno-memgate-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
}

describe('memory subprocess gate — detection', () => {
  it('passes when only the boundary names the module', () => {
    const root = fixture({
      'packages/boundary.ts': `const m = ${ARGV}.join('.');\n`,
      'packages/other.ts': "export const unrelated = 'nothing to see';\n",
    });
    expect(findMemorySubprocessViolations(root, ['packages'], ['packages/boundary.ts'])).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('GOES RED on the literal dotted module path outside the boundary', () => {
    const root = fixture({
      'packages/boundary.ts': `const m = ${ARGV}.join('.');\n`,
      'packages/sneaky.ts': `spawn('python', ['-m', '${DOTTED}']);\n`,
    });
    expect(findMemorySubprocessViolations(root, ['packages'], ['packages/boundary.ts'])).toEqual([
      'packages/sneaky.ts',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('GOES RED on the assembled form too — otherwise the gate teaches evasion', () => {
    // A gate that catches only the literal string trains the next author to
    // build it from parts, which is worse than no gate: the boundary looks
    // enforced while being routinely bypassed.
    const root = fixture({
      'packages/boundary.ts': `const m = ${ARGV}.join('.');\n`,
      'packages/clever.ts': `const parts = ${ARGV};\nspawn('python', ['-m', parts.join('.')]);\n`,
    });
    expect(findMemorySubprocessViolations(root, ['packages'], ['packages/boundary.ts'])).toEqual([
      'packages/clever.ts',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not exempt test files', () => {
    const root = fixture({
      'packages/boundary.ts': `const m = ${ARGV}.join('.');\n`,
      'packages/__tests__/leak.test.ts': `const m = '${DOTTED}';\n`,
    });
    expect(
      findMemorySubprocessViolations(root, ['packages'], ['packages/boundary.ts']),
    ).toContain('packages/__tests__/leak.test.ts');
    rmSync(root, { recursive: true, force: true });
  });

  it('skips node_modules', () => {
    const root = fixture({
      'packages/boundary.ts': `const m = ${ARGV}.join('.');\n`,
      'packages/node_modules/vendor/index.js': `require('${DOTTED}');\n`,
    });
    expect(findMemorySubprocessViolations(root, ['packages'], ['packages/boundary.ts'])).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a stale allowlist entry — the quiet way a gate stops meaning anything', () => {
    // If the provider is renamed and the allowlist is not, every file becomes
    // "not the boundary" and the gate passes on a codebase with no boundary.
    const root = fixture({ 'packages/boundary.ts': "export const nothing = 'here';\n" });
    expect(findStaleMemoryBoundaryEntries(root, ['packages/boundary.ts'])).toEqual([
      'packages/boundary.ts',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a nonexistent allowlist entry', () => {
    const root = fixture({ 'packages/boundary.ts': `const m = ${ARGV}.join('.');\n` });
    expect(findStaleMemoryBoundaryEntries(root, ['packages/gone.ts'])).toEqual(['packages/gone.ts']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('memory subprocess gate — this repository', () => {
  it('holds right now', () => {
    expect(findMemorySubprocessViolations(REPO_ROOT)).toEqual([]);
    expect(findStaleMemoryBoundaryEntries(REPO_ROOT)).toEqual([]);
  });

  it('pins the allowlist to exactly one file', () => {
    // A second entry means the memory seam has two owners, which is the failure
    // mode the gate exists to prevent. Changing this list is the review
    // checkpoint, and this assertion is what forces the conversation.
    expect(MEMORY_SUBPROCESS_BOUNDARY_FILES).toEqual([
      'packages/shared/src/memory/headroom-mcp-provider.ts',
    ]);
  });

  it('names the module it is guarding', () => {
    expect(HEADROOM_MEMORY_MODULE).toBe(DOTTED);
  });
});
