#!/usr/bin/env bun
/**
 * check-i18n-coverage.ts — CI-safe i18n coverage check.
 *
 * Verifies every literal `t('...')` / `i18n.t('...')` / `<Trans i18nKey="...">`
 * callsite under apps/electron/src and packages/**\/src resolves to a key in
 * `packages/shared/src/i18n/locales/en.json`.
 *
 * Dynamic keys (template literals, variables) are out of scope by design —
 * those surface via i18next's runtime missing-key warnings. See
 * `packages/shared/CLAUDE.md` → "i18n → Validation".
 *
 * A literal key `foo.bar` is considered resolvable if either:
 *   - `foo.bar` exists in en.json, OR
 *   - any plural variant `foo.bar_{zero,one,two,few,many,other}` exists
 *     (i18next plural lookup pattern).
 *
 * Exits 0 on success, 1 with `path:line  key` diagnostics otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'

const ROOT = resolve(
  import.meta.dir ?? new URL('.', import.meta.url).pathname,
  '..',
)

const SCAN_ROOTS = [
  resolve(ROOT, 'apps', 'electron', 'src'),
  resolve(ROOT, 'packages'),
]

const EN_JSON = resolve(
  ROOT,
  'packages',
  'shared',
  'src',
  'i18n',
  'locales',
  'en.json',
)

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

const SOURCE_EXT = /\.(?:ts|tsx)$/
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '__tests__',
  '__mocks__',
  '__fixtures__',
])
const SKIP_FILE = /\.(?:test|spec)\.[tj]sx?$|\.d\.ts$/

// Only `packages/<x>/src/**` — skip generated `dist/` and unrelated subtrees.
const isPackageSrcPath = (p: string): boolean =>
  /\/packages\/[^/]+\/src(\/|$)/.test(p)

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      yield* walk(full)
    } else if (SOURCE_EXT.test(name) && !SKIP_FILE.test(name)) {
      yield full
    }
  }
}

// Match literal-string callsites only. The leading boundary `[^.\w]` (or BOL)
// prevents matching `foo.t('x')` (a different `.t` method) and `xt('x')`.
// We intentionally do NOT match template-literal forms.
const T_CALL = /(?:^|[^.\w])t\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*[,)]/g
const I18N_T_CALL = /\bi18n\.t\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*[,)]/g
const TRANS_KEY = /<Trans\b[^>]*\bi18nKey\s*=\s*(['"])((?:\\.|(?!\1).)*?)\1/g

interface CallSite {
  file: string
  line: number
  key: string
  shape: 't' | 'i18n.t' | 'Trans'
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++
  }
  return line
}

function extractFromFile(file: string): CallSite[] {
  const src = readFileSync(file, 'utf-8')
  const sites: CallSite[] = []
  for (const re of [
    [T_CALL, 't'] as const,
    [I18N_T_CALL, 'i18n.t'] as const,
    [TRANS_KEY, 'Trans'] as const,
  ]) {
    const [pattern, shape] = re
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(src)) !== null) {
      const key = m[2]
      // Skip empty keys and keys that look like sentence-only strings (no dot
      // and contains spaces) — those are almost certainly false positives from
      // a non-i18n `t` (e.g. tooltip text). All real i18n keys use dot-paths.
      if (!key) continue
      if (!key.includes('.') && /\s/.test(key)) continue
      sites.push({
        file,
        line: lineOf(src, m.index),
        key,
        shape,
      })
    }
  }
  return sites
}

function loadEnKeys(): Set<string> {
  const en = JSON.parse(readFileSync(EN_JSON, 'utf-8')) as Record<string, unknown>
  return new Set(Object.keys(en))
}

function resolves(key: string, enKeys: Set<string>): boolean {
  if (enKeys.has(key)) return true
  for (const suf of PLURAL_SUFFIXES) {
    if (enKeys.has(`${key}${suf}`)) return true
  }
  return false
}

function main(): void {
  const enKeys = loadEnKeys()
  const sites: CallSite[] = []

  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      // For `packages/`, restrict to each package's `src/`.
      if (file.includes('/packages/') && !isPackageSrcPath(file)) continue
      sites.push(...extractFromFile(file))
    }
  }

  const missing: CallSite[] = []
  for (const site of sites) {
    if (!resolves(site.key, enKeys)) missing.push(site)
  }

  // Dedupe diagnostics on (file, line, key) so one site doesn't report twice.
  const seen = new Set<string>()
  const unique = missing.filter((s) => {
    const id = `${s.file}:${s.line}:${s.key}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  if (unique.length) {
    console.error(
      `i18n coverage check failed: ${unique.length} callsite(s) reference keys missing from en.json\n`,
    )
    for (const s of unique.slice(0, 50)) {
      const rel = relative(ROOT, s.file)
      console.error(`  ${rel}:${s.line}  ${s.shape}  ${s.key}`)
    }
    if (unique.length > 50) {
      console.error(`  … and ${unique.length - 50} more`)
    }
    process.exit(1)
  }

  const uniqKeys = new Set(sites.map((s) => s.key)).size
  console.log(
    `i18n coverage OK (${sites.length} callsites, ${uniqKeys} distinct keys, ${enKeys.size} keys in en.json)`,
  )
}

main()
