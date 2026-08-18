#!/usr/bin/env bun
/**
 * Branding gate (VOR-3) — fails CI on brand strings or upstream endpoints
 * hardcoded outside the branding module.
 *
 * Every user-visible brand string and external endpoint must route through
 * packages/core/src/branding.ts (re-exported as @craft-agent/shared/branding).
 * This keeps the future rebrand a one-module flip and stops weekly upstream
 * merges from silently reintroducing "Craft" strings or craft.do endpoints —
 * the worst case being auto-update/telemetry pointing at upstream infra.
 *
 * Exemptions live in scripts/branding-allowlist.json (a reviewed file — do
 * NOT add inline exceptions here). Classes used there:
 *   - wire-contract:  protocol/internal identifiers that must never change
 *                     (see roadmap/upstream/compatibility.md)
 *   - upstream-internal: upstream-owned files/demo data we don't rebrand
 *   - flip-sync:      static files (yml/json/html) that cannot import TS and
 *                     must be swept manually by the rebrand flip ticket
 *   - flip-deferred:  source we intentionally defer to the flip ticket
 *                     (i18n locale values, dependency-free packages)
 *
 * Heuristics: comment lines (//, *, /*, #, <!--) are skipped — comments are
 * not user-visible. Test files are skipped. Bare "Craft" (e.g. references to
 * the Craft docs product as an external source) is intentionally not gated.
 *
 * Usage: bun run scripts/check-branding.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * Files the gate cannot scan without flagging itself.
 *
 * The branding module (and its re-export) is the one allowed home for these
 * strings. The gate's own rule table and its allowlist necessarily *contain*
 * the patterns they match — scanning them is a guaranteed false positive, so
 * they are exempt structurally rather than via an allowlist entry that would
 * itself need an allowlist entry.
 */
const SELF_EXEMPT_FILES = new Set([
  'packages/core/src/branding.ts',
  'packages/shared/src/branding.ts',
  'scripts/check-branding.ts',
  'scripts/branding-allowlist.json',
]);

/** Surfaces under the gate. packages/server-core and packages/server are
 * upstream internals and out of scope (ticket VOR-3). */
const SCAN_ROOTS = [
  'apps/electron',
  'apps/webui',
  'apps/viewer',
  'apps/cli',
  'apps/server',
  'packages/core',
  'packages/shared',
  'packages/ui',
  'packages/session-tools-core',
  'packages/session-mcp-server',
  'scripts',
];

/**
 * Individually-listed repo-root files. Scanned by name, bypassing SCAN_EXTENSIONS
 * (`Dockerfile.server` would read as extension `.server`, `.dockerignore` as
 * `.dockerignore`). These ship real artifacts: OCI image LABELs are user-visible
 * in `docker inspect` and registry UIs, and the .dockerignore is where upstream's
 * v0.12.0 `apps/docs-site` stanza landed.
 *
 * Root markdown is deliberately NOT scanned. README/NOTICE/TRADEMARK/CONTRIBUTING/
 * ROADMAP/CODE_OF_CONDUCT name "Craft Agents" as required attribution and
 * trademark notice (Apache-2.0 + TRADEMARK.md) — measured at ~30 hits across six
 * files, all correct. Gating them would mean blanket per-file allowlists, which is
 * how a gate stops meaning anything. `.md` is absent from SCAN_EXTENSIONS for the
 * same reason.
 */
const SCAN_ROOT_FILES = ['Dockerfile.server', '.dockerignore'];

const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.json', '.yml', '.yaml', '.css',
  '.sh', '.ps1',
]);

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'out', 'coverage', 'build', '.vite', '__tests__', '__snapshots__']);

const SKIP_FILE_RE = /(\.test\.[jt]sx?|\.isolated\.ts|\.d\.ts|\.min\.js|\.lock|\.map)$/;

interface Rule {
  id: string;
  re: RegExp;
  description: string;
}

const RULES: Rule[] = [
  {
    id: 'product-name',
    re: /Craft Agents?/,
    description: 'Product name — import PRODUCT_NAME / PRODUCT_NAME_SINGULAR / BACKEND_DISPLAY_NAME from the branding module',
  },
  {
    id: 'upstream-domain',
    // Upstream migrated agents.craft.do -> thecraftagents.com in v0.12.0; both must be caught
    // so a sync cannot silently reintroduce a hardcoded upstream endpoint.
    re: /craft\.do|thecraftagents\.com/i,
    description: 'Upstream endpoint (craft.do / thecraftagents.com) — import SERVICE_BASE_URL / DOCS_URL / UPDATE_MANIFEST_BASE_URL / OAUTH_RELAY_* from the branding module',
  },
  {
    id: 'lukilabs',
    re: /lukilabs|luki labs/i,
    description: 'Upstream org / bundle identifier — bundle-ID changes are sequenced with VOR-2; anything else should not be added',
  },
];

interface AllowlistEntry {
  path: string;
  rules?: string[];
  class: string;
  reason: string;
}

const allowlistFile = join(REPO_ROOT, 'scripts', 'branding-allowlist.json');
const allowlist: { entries: AllowlistEntry[] } = JSON.parse(readFileSync(allowlistFile, 'utf8'));
const usedEntries = new Set<AllowlistEntry>();

function isAllowed(relPath: string, ruleId: string): boolean {
  for (const entry of allowlist.entries) {
    if (!relPath.startsWith(entry.path)) continue;
    if (entry.rules && !entry.rules.includes(ruleId)) continue;
    usedEntries.add(entry);
    return true;
  }
  return false;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  // Markdown bold (`**Product documentation:** …`) is NOT a comment — it is prompt/UX
  // text inside a template literal. JSDoc continuation lines are `* text`, never `** text`,
  // so excluding the `**` case is safe and closes a real blind spot: upstream v0.12.0 landed
  // a brand-visible docs pointer in the system prompt that this heuristic silently skipped.
  if (t.startsWith('**')) return false;
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#') || t.startsWith('<!--');
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

interface Violation {
  file: string;
  line: number;
  ruleId: string;
  text: string;
}

const violations: Violation[] = [];

const filesToScan: string[] = [];
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(REPO_ROOT, root))) {
    const relPath = relative(REPO_ROOT, file);
    const ext = relPath.slice(relPath.lastIndexOf('.'));
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    filesToScan.push(file);
  }
}
for (const name of SCAN_ROOT_FILES) filesToScan.push(join(REPO_ROOT, name));

for (const file of filesToScan) {
  const relPath = relative(REPO_ROOT, file);
  if (SKIP_FILE_RE.test(relPath)) continue;
  if (SELF_EXEMPT_FILES.has(relPath)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (isCommentLine(rawLine)) continue;
    // Trailing line comments are not user-visible; `https://` never matches
    // the ' // ' separator, so URLs in code survive the split.
    // Known limitation: the split is textual — a string literal that itself
    // contains ' // ' would have its tail (and any violation there) skipped.
    const line = rawLine.split(' // ')[0]!;
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (isAllowed(relPath, rule.id)) continue;
      violations.push({ file: relPath, line: i + 1, ruleId: rule.id, text: line.trim().slice(0, 160) });
    }
  }
}

const staleEntries = allowlist.entries.filter((e) => !usedEntries.has(e));
if (staleEntries.length > 0) {
  console.warn('⚠ Stale allowlist entries (no matching occurrences — consider removing):');
  for (const e of staleEntries) console.warn(`  - ${e.path}${e.rules ? ` [${e.rules.join(', ')}]` : ''}`);
}

if (violations.length > 0) {
  console.error(`\n✗ Branding gate: ${violations.length} non-allowlisted brand/endpoint occurrence(s) outside the branding module.\n`);
  for (const v of violations) {
    const rule = RULES.find((r) => r.id === v.ruleId)!;
    console.error(`  ${v.file}:${v.line} [${v.ruleId}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${rule.description}`);
  }
  console.error('\nRoute the value through packages/core/src/branding.ts (import via @craft-agent/shared/branding),');
  console.error('or — only for wire contracts and upstream internals — add a reviewed entry to scripts/branding-allowlist.json.');
  console.error('See docs/branding-inventory.md and roadmap/upstream/compatibility.md.');
  process.exit(1);
}

console.log('✓ Branding gate clean — no hardcoded brand strings or upstream endpoints outside the branding module.');
