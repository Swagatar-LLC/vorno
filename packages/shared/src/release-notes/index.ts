/**
 * Release Notes Utilities
 *
 * Loads release notes from bundled assets and syncs them to ~/.craft-agent/release-notes/.
 * Follows the same pattern as docs/index.ts.
 *
 * Source content lives in apps/electron/resources/release-notes/*.md.
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { CONFIG_DIR } from '../config/paths.ts';

const RELEASE_NOTES_DIR = join(CONFIG_DIR, 'release-notes');

let releaseNotesInitialized = false;

/**
 * Only versioned files (`X.Y.Z.md`, optionally `X.Y.Z-prerelease.md`) are release
 * notes. The resources folder also ships `next.md`, the pending-notes template
 * that accumulates bullets between releases; without this filter it loaded as
 * version "next", was synced to ~/.craft-agent/release-notes/, and hit the
 * semver sort as NaN.
 *
 * The prerelease suffix follows SemVer 2.0.0's dot-separated alphanumeric/hyphen
 * identifier grammar (e.g. `0.22.0-beta.1.md`). Build metadata (`+...`) is not
 * a thing we ever ship in a filename, so it's deliberately not accepted here.
 */
const RELEASE_NOTE_FILENAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\.md$/;

export function isReleaseNoteFilename(filename: string): boolean {
  return RELEASE_NOTE_FILENAME.test(filename);
}

function getAssetsDir(): string {
  return getBundledAssetsDir('release-notes')
    ?? join(process.cwd(), 'resources', 'release-notes');
}

/**
 * Load bundled release notes from asset files.
 * Returns { filename → content } map.
 */
function loadBundledReleaseNotes(): Record<string, string> {
  const assetsDir = getAssetsDir();
  const notes: Record<string, string> = {};

  // Try bundled assets first, fall back to ~/.craft-agent/release-notes/
  // (Docker/remote server may not have CRAFT_BUNDLED_ASSETS_ROOT set,
  // but initializeReleaseNotes() copies files to the config dir at startup)
  let dir = assetsDir;
  if (!existsSync(dir)) {
    dir = RELEASE_NOTES_DIR;
  }

  let files: string[];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter(isReleaseNoteFilename) : [];
  } catch {
    console.warn(`[release-notes] Could not read release notes dir: ${dir}`);
    return notes;
  }

  for (const filename of files) {
    const filePath = join(dir, filename);
    try {
      notes[filename] = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`[release-notes] Failed to load ${filename}:`, error);
    }
  }

  return notes;
}

let _bundledNotes: Record<string, string> | null = null;

function getBundledReleaseNotes(): Record<string, string> {
  if (_bundledNotes === null) {
    _bundledNotes = loadBundledReleaseNotes();
  }
  return _bundledNotes;
}

/**
 * Initialize release notes directory with bundled content.
 * Call at app startup alongside initializeDocs().
 */
export function initializeReleaseNotes(): void {
  if (releaseNotesInitialized) return;
  releaseNotesInitialized = true;

  if (!existsSync(RELEASE_NOTES_DIR)) {
    mkdirSync(RELEASE_NOTES_DIR, { recursive: true });
  }

  const bundledNotes = getBundledReleaseNotes();
  for (const [filename, content] of Object.entries(bundledNotes)) {
    const notePath = join(RELEASE_NOTES_DIR, filename);
    writeFileSync(notePath, content, 'utf-8');
  }

  debug(`[release-notes] Synced ${Object.keys(bundledNotes).length} release notes`);
}

/**
 * Parse version from filename (e.g., "0.4.1.md" → "0.4.1").
 */
function parseVersion(filename: string): string {
  return filename.replace(/\.md$/, '');
}

/**
 * Compare two dot-separated SemVer prerelease identifier lists per SemVer 2.0.0
 * rule 11.4: numeric identifiers compare numerically and are always lower than
 * alphanumeric ones; when all shared identifiers are equal, the longer list
 * takes precedence. Returns negative if `a` < `b`, positive if `a` > `b`.
 */
function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers always have lower precedence
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Split "0.22.0-beta.1" into ["0.22.0", "beta.1"] on the FIRST hyphen only.
 * Not `split('-', 2)`: JS truncates at the limit instead of keeping the
 * remainder, so "1.0.0-alpha-2.1" would silently lose its trailing
 * identifiers — prerelease identifiers are allowed to contain hyphens.
 */
function splitPrerelease(version: string): [string, string | undefined] {
  const i = version.indexOf('-');
  return i === -1 ? [version, undefined] : [version.slice(0, i), version.slice(i + 1)];
}

/**
 * Compare semver strings for sorting (descending — newest first). A prerelease
 * (e.g. "0.22.0-beta.1") has lower precedence than its associated stable
 * release ("0.22.0"), so "0.22.0" sorts before "0.22.0-beta.1".
 */
export function compareSemver(a: string, b: string): number {
  const [aCore, aPre] = splitPrerelease(a);
  const [bCore, bPre] = splitPrerelease(b);
  const pa = aCore.split('.').map(Number);
  const pb = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return -1; // stable beats prerelease of the same core version
  if (bPre === undefined) return 1;
  return comparePrereleaseIdentifiers(bPre.split('.'), aPre.split('.')); // descending
}

/** Maximum number of release notes to display in the UI. */
const MAX_DISPLAY_NOTES = 10;

export interface ReleaseNote {
  version: string;
  content: string;
}

/**
 * Get release notes sorted newest-first, limited to the most recent 10.
 */
export function getReleaseNotesList(): ReleaseNote[] {
  const notes = getBundledReleaseNotes();
  return Object.entries(notes)
    .map(([filename, content]) => ({
      version: parseVersion(filename),
      content,
    }))
    .sort((a, b) => compareSemver(a.version, b.version))
    .slice(0, MAX_DISPLAY_NOTES);
}

/**
 * Get the latest release note version string.
 */
export function getLatestReleaseVersion(): string | undefined {
  const list = getReleaseNotesList();
  return list[0]?.version;
}

/**
 * Get all release notes combined into a single markdown string.
 * Each version is separated by a horizontal rule.
 */
export function getCombinedReleaseNotes(): string {
  const list = getReleaseNotesList();
  return list.map(n => {
    // Auto-inject version header if the content doesn't start with one
    if (!n.content.trimStart().startsWith('# ')) {
      return `# v${n.version}\n\n${n.content}`;
    }
    return n.content;
  }).join('\n\n---\n\n');
}
