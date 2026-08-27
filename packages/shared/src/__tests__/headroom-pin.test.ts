/**
 * Supply-chain guards for the Headroom TypeScript SDK (SUV-0014).
 *
 * Two invariants, both of which have bitten this repo or are explicitly
 * required by the SUV's acceptance list:
 *
 * 1. The pin is an EXACT version. LEARNING-062 records what a range/dist-tag
 *    dependency costs: `"@types/bun": "latest"` broke `--frozen-lockfile` CI on
 *    every branch at once the moment upstream published, because the validity
 *    of the lockfile depended on publish timing rather than on anything in the
 *    repo. Headroom sits in the token path and sees all context; it is the last
 *    dependency that should float.
 *
 * 2. Only the boundary module imports it. SUV-0014 landed the dependency
 *    unreferenced and guarded that with a "no production file imports this"
 *    test, to be DELETED (not weakened) by whoever landed SUV-0015. SUV-0015
 *    has landed, so that guard is gone — succeeded by
 *    `scripts/check-headroom-boundary.ts`, which asserts the stronger and
 *    permanent invariant: exactly one file, the boundary module, may import the
 *    SDK. It runs as its own CI job and is unit-tested in
 *    `src/headroom/__tests__/boundary-gate.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_NAME = 'headroom-ai'
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const SHARED_MANIFEST = join(REPO_ROOT, 'packages', 'shared', 'package.json')

/** Exact semver only: no `^`, `~`, `*`, `x`, ranges, or dist-tags like `latest`. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, 'utf8'))
}

describe('headroom-ai pin (SUV-0014)', () => {
	it('is declared in @craft-agent/shared as an exact version', () => {
		const manifest = readJson(SHARED_MANIFEST)
		const spec = manifest.dependencies?.[PACKAGE_NAME]

		expect(spec).toBeDefined()
		expect(spec).toMatch(EXACT_SEMVER)
	})

	it('is not pinned to a floating range or dist-tag (LEARNING-062)', () => {
		const manifest = readJson(SHARED_MANIFEST)
		const spec: string = manifest.dependencies?.[PACKAGE_NAME] ?? ''

		for (const forbidden of ['^', '~', '*', 'latest', 'next', 'x', '>', '<', '||']) {
			expect(spec.includes(forbidden)).toBe(false)
		}
	})

	it('resolves in bun.lock at the same exact version', () => {
		const manifest = readJson(SHARED_MANIFEST)
		const spec = manifest.dependencies?.[PACKAGE_NAME]
		const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8')

		expect(lock).toContain(`"${PACKAGE_NAME}@${spec}"`)
	})
})
