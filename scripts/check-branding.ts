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
 * On top of that general pass, TARGETED_SCANS (below) covers a handful of
 * named surfaces the general pass deliberately does not reach — the bundled
 * Pages guide, Pages code in upstream-internal server-core, the publication
 * Worker, and the agent-visible tool descriptions.
 *
 * Usage: bun run scripts/check-branding.ts
 *        bun test scripts/check-branding.test.ts   # proves the rules fire
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  'scripts/check-branding.test.ts',
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

export const RULES: Rule[] = [
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

/**
 * Targeted scans (SUV-0061) — surfaces the general pass deliberately does not
 * reach, each paired with the one rule that must hold there.
 *
 * The general pass is narrow on purpose: `.md` is not a scanned extension,
 * `packages/server-core` is upstream-internal and out of SCAN_ROOTS, and
 * `apps/electron/resources/` carries a blanket allowlist entry. Every one of
 * those exclusions is still correct in general and is NOT widened here. But
 * Pages arrived from upstream with Craft-owned publication defaults and a
 * bundled guide that is both shipped UX and agent-visible instruction, so the
 * three specific ways a Craft endpoint or an upstream config-dir path can walk
 * back in on an upstream sync are gated individually.
 *
 * Allowlist interaction: a targeted rule is exempted ONLY by an allowlist entry
 * that names its rule id explicitly. A blanket entry (no `rules` field) covers
 * the general pass and does not silently disarm a targeted one — otherwise the
 * `apps/electron/resources/` entry would exempt the bundled Pages guide, which
 * is the main thing this scan exists to watch.
 */
interface TargetedScan {
  /** Rule id — reuses a RULES id where the rule is the same, so the existing reviewed allowlist entries still apply. */
  ruleId: string;
  re: RegExp;
  description: string;
  /** Repo-relative files or directories. */
  paths: string[];
}

const TARGETED_EXTENSIONS = new Set([...SCAN_EXTENSIONS, '.md']);

export const TARGETED_SCANS: TargetedScan[] = [
  {
    ruleId: 'upstream-domain',
    re: /craft\.do|thecraftagents\.com/i,
    description:
      'Upstream endpoint on a Pages surface — fresh publication targets only the Vorno Pages endpoint. Recognizing a stored legacy URL for revocation is the single allowlisted exception (packages/shared/src/pages/publisher.ts).',
    paths: [
      // Bundled guide: shipped UX and the authoring instruction agents read.
      'apps/electron/resources/docs/pages.md',
      // Pages code inside upstream-internal server-core, which SCAN_ROOTS skips.
      'packages/server-core/src/pages',
      'packages/server-core/src/handlers/rpc/pages.ts',
      'packages/server-core/src/sessions/page-callback-guards.ts',
      // Publication client + bundle (already under the general pass; listed so
      // the surface is complete rather than depending on SCAN_ROOTS staying put).
      'packages/shared/src/pages',
      // Vorno-owned publication Worker — must never name Craft infrastructure.
      'workers/pages',
    ],
  },
  {
    ruleId: 'upstream-config-dir-path',
    re: /\.craft-agent\/docs\//,
    description:
      "Upstream config-dir doc path in agent-visible text — that directory does not exist in a Vorno install, so the pointer is dead. Use DOC_REFS (packages/shared/src/docs/index.ts); where the package cannot import it (session-tools-core, which shared depends on), name the guide without a path and append DOC_REFS in shared/agent/session-scoped-tools.ts.",
    paths: [
      'packages/session-tools-core/src',
      'packages/shared/src/agent/session-scoped-tools.ts',
      'packages/shared/src/prompts/system.ts',
      'apps/electron/resources/docs/pages.md',
    ],
  },
];

function matchesTargetedPath(relPath: string, paths: string[]): boolean {
  return paths.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

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

/** Targeted scans honour only rule-scoped entries — see TARGETED_SCANS. */
function isAllowedForTargetedScan(relPath: string, ruleId: string): boolean {
  for (const entry of allowlist.entries) {
    if (!relPath.startsWith(entry.path)) continue;
    if (!entry.rules?.includes(ruleId)) continue;
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

/**
 * Markdown has none of the code comment syntaxes above. Applying them would
 * skip every `#` heading and every `*` bullet, which is most of a guide — a
 * "## Publish to <upstream endpoint>" heading would read as a comment and pass.
 *
 * The one real markdown comment is `<!-- -->`, and it spans lines. Rather than
 * decide per line whether to skip it, strip the commented spans and scan what
 * is left: a line that opens or closes a comment keeps its visible half, and a
 * legacy endpoint commented out across several lines cannot fail CI for text no
 * reader ever sees.
 */
function stripMarkdownComments(lines: string[]): string[] {
  let open = false;
  return lines.map((line) => {
    let visible = '';
    let i = 0;
    while (i < line.length) {
      if (open) {
        const close = line.indexOf('-->', i);
        if (close === -1) return visible;
        i = close + 3;
        open = false;
        continue;
      }
      const start = line.indexOf('<!--', i);
      if (start === -1) {
        visible += line.slice(i);
        return visible;
      }
      visible += line.slice(i, start);
      i = start + 4;
      open = true;
    }
    return visible;
  });
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

export interface Violation {
  file: string;
  line: number;
  ruleId: string;
  text: string;
  /** The description of the pass that caught it — the general and targeted
   *  passes share rule ids but not remedies, so this is recorded rather than
   *  looked up by id afterwards. */
  description: string;
}

/**
 * Scan one file's content. Exported so the gate's own rules can be
 * mutation-tested (scripts/check-branding.test.ts) against synthetic content at
 * a real repo path, instead of only ever being observed passing on a clean tree.
 */
export function scanFile(relPath: string, content: string): Violation[] {
  if (SKIP_FILE_RE.test(relPath)) return [];
  if (SELF_EXEMPT_FILES.has(relPath)) return [];

  const ext = relPath.slice(relPath.lastIndexOf('.'));
  const inGeneralPass =
    (SCAN_ROOTS.some((root) => relPath.startsWith(`${root}/`)) && SCAN_EXTENSIONS.has(ext))
    || SCAN_ROOT_FILES.includes(relPath);
  const targeted = TARGETED_EXTENSIONS.has(ext)
    ? TARGETED_SCANS.filter((scan) => matchesTargetedPath(relPath, scan.paths))
    : [];
  if (!inGeneralPass && targeted.length === 0) return [];

  const markdown = ext === '.md';
  const violations: Violation[] = [];
  const rawLines = content.split('\n');
  const lines = markdown ? stripMarkdownComments(rawLines) : rawLines;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (!markdown && isCommentLine(rawLine)) continue;
    // Trailing line comments are not user-visible; `https://` never matches
    // the ' // ' separator, so URLs in code survive the split.
    // Known limitation: the split is textual — a string literal that itself
    // contains ' // ' would have its tail (and any violation there) skipped.
    // Markdown has no `//` comment, and prose legitimately contains ' // '.
    const line = markdown ? rawLine : rawLine.split(' // ')[0]!;

    // Keyed by rule id: the two passes share ids, and a file in both must be
    // reported once. The targeted entry is written last and wins, because
    // "import it from the branding module" is the wrong remedy for a
    // bundled-markdown or Worker hit.
    const byRule = new Map<string, string>();
    if (inGeneralPass) {
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue;
        if (isAllowed(relPath, rule.id)) continue;
        byRule.set(rule.id, rule.description);
      }
    }
    for (const scan of targeted) {
      if (!scan.re.test(line)) continue;
      if (isAllowedForTargetedScan(relPath, scan.ruleId)) continue;
      byRule.set(scan.ruleId, scan.description);
    }
    for (const [ruleId, description] of byRule) {
      violations.push({ file: relPath, line: i + 1, ruleId, text: line.trim().slice(0, 160), description });
    }
  }
  return violations;
}

/**
 * Candidate files, filtered by extension BEFORE anything is read.
 *
 * `apps/electron` is a scan root and carries multi-megabyte binaries
 * (Assets.car, a 11 MB .tiff, icon PNGs). Reading and utf8-decoding those on
 * every gate run to have scanFile discard them by extension is pure waste, and
 * one unreadable asset would fail a gate that has no opinion about it.
 */
function collectFiles(): string[] {
  const files = new Set<string>();
  const addIfScannable = (file: string, extensions: Set<string>) => {
    const ext = file.slice(file.lastIndexOf('.'));
    if (extensions.has(ext)) files.add(file);
  };
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) addIfScannable(file, SCAN_EXTENSIONS);
  }
  for (const name of SCAN_ROOT_FILES) files.add(join(REPO_ROOT, name));
  for (const scan of TARGETED_SCANS) {
    for (const p of scan.paths) {
      const abs = join(REPO_ROOT, p);
      if (!existsSync(abs)) {
        // A renamed or deleted targeted path is a silently disarmed gate, which
        // is the failure mode this whole file exists to prevent. Fail loudly.
        console.error(`\n✗ Branding gate: targeted scan path does not exist: ${p}`);
        console.error('  Update TARGETED_SCANS in scripts/check-branding.ts to the new location.');
        process.exit(1);
      }
      if (statSync(abs).isDirectory()) {
        for (const file of walk(abs)) addIfScannable(file, TARGETED_EXTENSIONS);
      } else {
        files.add(abs);
      }
    }
  }
  return [...files];
}

function main(): void {
  const violations: Violation[] = [];
  for (const file of collectFiles()) {
    const relPath = relative(REPO_ROOT, file);
    violations.push(...scanFile(relPath, readFileSync(file, 'utf8')));
  }

  const staleEntries = allowlist.entries.filter((e) => !usedEntries.has(e));
  if (staleEntries.length > 0) {
    console.warn('⚠ Stale allowlist entries (no matching occurrences — consider removing):');
    for (const e of staleEntries) console.warn(`  - ${e.path}${e.rules ? ` [${e.rules.join(', ')}]` : ''}`);
  }

  if (violations.length > 0) {
    console.error(`\n✗ Branding gate: ${violations.length} non-allowlisted brand/endpoint occurrence(s) outside the branding module.\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.ruleId}]`);
      console.error(`    ${v.text}`);
      console.error(`    → ${v.description}`);
    }
    console.error('\nRoute the value through packages/core/src/branding.ts (import via @craft-agent/shared/branding),');
    console.error('or — only for wire contracts and upstream internals — add a reviewed entry to scripts/branding-allowlist.json.');
    console.error('See docs/branding-inventory.md and roadmap/upstream/compatibility.md.');
    process.exit(1);
  }

  console.log('✓ Branding gate clean — no hardcoded brand strings or upstream endpoints outside the branding module.');
}

// Importing this module (the test does) must not run the scan or exit.
if (import.meta.main) main();
