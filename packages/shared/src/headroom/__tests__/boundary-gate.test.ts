/**
 * Tests for the Headroom boundary gate (SUV-0015).
 *
 * The gate is the acceptance item that has no other way of being verified: a
 * grep that never fires proves nothing. These tests point the gate's own
 * detection function at a fixture tree containing a deliberate violation, so we
 * have watched it go red, and at the real repository, so the shipped invariant
 * is asserted on every run rather than only in CI.
 *
 * The violating import in the fixture is assembled from fragments. Written whole
 * it would be a real violation in a real file under `packages/`, and the gate —
 * correctly — would fail the build on its own test suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOUNDARY_FILES,
  HEADROOM_PACKAGE,
  findBoundaryViolations,
  findStaleBoundaryEntries,
} from '../../../../../scripts/check-headroom-boundary.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/**
 * A static import of the SDK, assembled at runtime.
 *
 * Note the fragments below never place the package name in quotes next to an
 * import keyword — not even in a comment. The gate reads source text and cannot
 * tell prose from code, so an illustrative example written out longhand here
 * would fail the build on this very file. That is the correct trade: a gate
 * strict enough to be worth having is strict enough to catch its own docs.
 */
const VIOLATING_IMPORT = `import { HeadroomClient } from ${JSON.stringify(HEADROOM_PACKAGE)}\n`;
const VIOLATING_SUBPATH = `const m = await import(${JSON.stringify(`${HEADROOM_PACKAGE}/openai`)})\n`;
const VIOLATING_REQUIRE = `const m = require(${JSON.stringify(HEADROOM_PACKAGE)})\n`;

describe('headroom boundary gate — detection (SUV-0015)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'headroom-gate-'));
    mkdirSync(join(root, 'packages', 'shared', 'src', 'headroom'), { recursive: true });
    mkdirSync(join(root, 'packages', 'shared', 'src', 'agent'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'headroom', 'sdk-adapter.ts'),
      VIOLATING_IMPORT,
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const allowed = ['packages/shared/src/headroom/sdk-adapter.ts'];

  it('passes when only the boundary imports the SDK', () => {
    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([]);
  });

  it('fails when another file imports the SDK', () => {
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'agent', 'claude-agent.ts'),
      VIOLATING_IMPORT,
    );

    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([
      'packages/shared/src/agent/claude-agent.ts',
    ]);
  });

  it('catches a dynamic import of a subpath, not just a top-level static import', () => {
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'agent', 'lazy.ts'),
      VIOLATING_SUBPATH,
    );

    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([
      'packages/shared/src/agent/lazy.ts',
    ]);
  });

  it('catches a CommonJS require', () => {
    writeFileSync(join(root, 'packages', 'shared', 'src', 'agent', 'legacy.cjs'), VIOLATING_REQUIRE);

    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([
      'packages/shared/src/agent/legacy.cjs',
    ]);
  });

  it('does not fire on the package name in prose or in a string constant', () => {
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'agent', 'docs.ts'),
      `// We integrate ${HEADROOM_PACKAGE} behind a boundary.\n` +
        `export const PKG = ${JSON.stringify(HEADROOM_PACKAGE)}\n`,
    );

    // A gate that fires on documentation gets suppressed, and a suppressed gate
    // enforces nothing.
    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([]);
  });

  it('does not exempt test files', () => {
    mkdirSync(join(root, 'packages', 'shared', 'src', 'agent', '__tests__'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'agent', '__tests__', 'a.test.ts'),
      VIOLATING_IMPORT,
    );

    // A test that reaches around the boundary can stay green while the boundary
    // rots, which is worse than no test.
    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([
      'packages/shared/src/agent/__tests__/a.test.ts',
    ]);
  });

  it('skips node_modules — the SDK imports itself', () => {
    mkdirSync(join(root, 'packages', 'shared', 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'shared', 'node_modules', 'x', 'index.js'),
      VIOLATING_IMPORT,
    );

    expect(findBoundaryViolations(root, ['packages'], allowed)).toEqual([]);
  });

  it('reports an allowlisted boundary file that no longer imports the SDK', () => {
    writeFileSync(
      join(root, 'packages', 'shared', 'src', 'headroom', 'sdk-adapter.ts'),
      '// boundary moved elsewhere\n',
    );

    // Otherwise renaming the boundary makes every file "not the boundary" and
    // the gate passes on a codebase that has no boundary at all.
    expect(findStaleBoundaryEntries(root, allowed)).toEqual([
      'packages/shared/src/headroom/sdk-adapter.ts',
    ]);
  });

  it('reports an allowlisted boundary file that does not exist', () => {
    expect(findStaleBoundaryEntries(root, ['packages/shared/src/headroom/gone.ts'])).toEqual([
      'packages/shared/src/headroom/gone.ts',
    ]);
  });
});

describe('headroom boundary gate — this repository (SUV-0015)', () => {
  it('has exactly one file importing the Headroom SDK', () => {
    expect(findBoundaryViolations(REPO_ROOT)).toEqual([]);
    expect(findStaleBoundaryEntries(REPO_ROOT)).toEqual([]);
  });

  it('allowlists exactly the boundary module', () => {
    expect(BOUNDARY_FILES).toEqual(['packages/shared/src/headroom/sdk-adapter.ts']);
  });
});
