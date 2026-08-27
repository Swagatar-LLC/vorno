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
 * 2. Nothing imports it yet. SUV-0014 deliberately lands the dependency
 *    unreferenced — runtime wiring is SUV-0015 (boundary module) and SUV-0016
 *    (config surfaces). This guard is the executable form of the SUV's
 *    "verifiable by grep" acceptance item, and it should be DELETED (not
 *    weakened) by whoever lands SUV-0015.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/** Source roots that ship to users. Tests and this guard are excluded by name. */
const SOURCE_ROOTS = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages')]
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'out',
	'.git',
	'coverage',
	'__tests__',
	'tests',
])
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return acc
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue
		const full = join(dir, entry)

		let isDir: boolean
		try {
			isDir = statSync(full).isDirectory()
		} catch {
			continue
		}

		if (isDir) {
			collectSourceFiles(full, acc)
		} else if (
			SOURCE_EXTS.some((ext) => entry.endsWith(ext)) &&
			!entry.includes('.test.') &&
			!entry.includes('.spec.')
		) {
			acc.push(full)
		}
	}

	return acc
}

describe('headroom-ai is unreferenced (SUV-0014 boundary)', () => {
	it('is imported by no production source file', () => {
		// Matches `from 'headroom-ai'`, `require('headroom-ai')`, and
		// `import('headroom-ai/adapters/...')` — but not the bare word in prose.
		const importPattern = new RegExp(
			`(from|require\\(|import\\()\\s*['"\`]${PACKAGE_NAME}(/[^'"\`]*)?['"\`]`,
		)

		const offenders = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(root)).filter((file) =>
			importPattern.test(readFileSync(file, 'utf8')),
		)

		expect(offenders.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([])
	})
})
