/**
 * Documentation Utilities
 *
 * Provides access to built-in documentation that Claude can reference
 * when performing configuration tasks (sources, agents, permissions, etc.).
 *
 * Docs are stored at ~/.craft-agent/docs/ and synced from bundled assets.
 * Source content lives in apps/electron/resources/docs/*.md for easier editing.
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, type Dirent } from 'fs';
import { dirname } from 'path';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { CONFIG_DIR } from '../config/paths.ts';

const DOCS_DIR = join(CONFIG_DIR, 'docs');

// Track if docs have been initialized this session (prevents re-init on hot reload)
let docsInitialized = false;

// Resolve the bundled docs assets directory using the shared asset resolver.
// Handles all environments: dev (resources/docs), bundled (dist/resources/docs),
// and packaged Electron (setBundledAssetsRoot sets the base path at startup).
function getAssetsDir(): string {
  return getBundledAssetsDir('docs')
    // Fallback: development path (will fail gracefully if files don't exist)
    ?? join(process.cwd(), 'resources', 'docs');
}

interface LoadedBundledDocs {
  /** Doc key → content. Keys are POSIX paths relative to the assets dir, so a
   *  subdirectory guide is "sources/github.md". This is the shipped manifest. */
  docs: Record<string, string>;
  /**
   * True only if EVERY entry under the assets dir was enumerated and read without
   * error. When false the manifest may be missing docs this build actually ships,
   * so the reconcile must delete nothing — a partial manifest wiping real guides
   * is the exact "worse than no guide" failure the sync exists to prevent.
   */
  complete: boolean;
}

/**
 * Load bundled docs from asset files.
 * Called once at module initialization.
 * Returns an empty (but `complete: false` on read failure) manifest if files
 * don't exist, so callers degrade gracefully and never delete on a bad read.
 */
function loadBundledDocs(): LoadedBundledDocs {
  const assetsDir = getAssetsDir();
  const docs: Record<string, string> = {};
  let complete = true;

  // Auto-discover all files in the bundled docs directory, including one level of
  // subdirectories (docs/sources/*.md holds the per-service setup guides).
  // No hardcoded list — any file dropped into resources/docs/ is synced automatically.
  // Keys are paths relative to assetsDir, so a subdirectory key is "sources/github.md".
  let entries: Dirent[];
  try {
    entries = existsSync(assetsDir) ? readdirSync(assetsDir, { withFileTypes: true }) : [];
  } catch {
    console.warn(`[docs] Could not read assets dir: ${assetsDir}`);
    // Could not enumerate the bundle at all — flag incomplete so a transient read
    // failure is never mistaken for "this build ships no docs" and used to prune.
    return { docs, complete: false };
  }

  for (const entry of entries) {
    const entryPath = join(assetsDir, entry.name);
    if (entry.isDirectory()) {
      // Nested docs (e.g. sources/). One level only — deeper nesting has no use
      // case and would just be a way to hide docs from the sync.
      let nested: Dirent[];
      try {
        nested = readdirSync(entryPath, { withFileTypes: true });
      } catch (error) {
        console.error(`[docs] Failed to read ${entry.name}/:`, error);
        complete = false;
        continue;
      }
      for (const nestedEntry of nested) {
        const key = `${entry.name}/${nestedEntry.name}`;
        if (nestedEntry.isDirectory()) {
          // A doc two levels deep can't be represented as a key, so it would never
          // sync. Flag the manifest incomplete rather than silently dropping it —
          // otherwise the reconcile could delete on-disk copies of shipped docs.
          console.error(`[docs] Ignoring unsupported nested directory ${key}/`);
          complete = false;
          continue;
        }
        try {
          docs[key] = readFileSync(join(entryPath, nestedEntry.name), 'utf-8');
        } catch (error) {
          console.error(`[docs] Failed to load ${key}:`, error);
          complete = false;
        }
      }
      continue;
    }
    try {
      docs[entry.name] = readFileSync(entryPath, 'utf-8');
    } catch (error) {
      console.error(`[docs] Failed to load ${entry.name}:`, error);
      complete = false;
    }
  }

  return { docs, complete };
}

// Lazy-loaded bundled docs cache.
// IMPORTANT: Must NOT load at module initialization because setBundledAssetsRoot()
// hasn't been called yet. Loading eagerly causes empty docs on fresh install.
let _loaded: LoadedBundledDocs | null = null;

/**
 * Get the loaded bundle (docs + completeness), loading lazily on first access.
 * This ensures docs are loaded AFTER setBundledAssetsRoot() has been called.
 */
function getLoadedBundledDocs(): LoadedBundledDocs {
  if (_loaded === null) {
    _loaded = loadBundledDocs();
  }
  return _loaded;
}

/** Get bundled docs (the shipped manifest, keyed by relative path). */
function getBundledDocs(): Record<string, string> {
  return getLoadedBundledDocs().docs;
}

/**
 * Get the docs directory path
 */
export function getDocsDir(): string {
  return DOCS_DIR;
}

/**
 * Get path to a specific doc file
 */
export function getDocPath(filename: string): string {
  return join(DOCS_DIR, filename);
}

// App root path reference for prompt/display text only.
// Derived from the active CONFIG_DIR (fork default ~/.vorno-agent, or a
// CRAFT_CONFIG_DIR override) so prompt references point at real files.
// Do NOT use APP_ROOT for real filesystem reads/writes.
// For runtime filesystem paths, use CONFIG_DIR from config/paths.ts.
export const APP_ROOT = CONFIG_DIR.startsWith(homedir())
  ? `~${CONFIG_DIR.slice(homedir().length)}`
  : CONFIG_DIR;

/**
 * Documentation file references for use in error messages and tool descriptions.
 * Use these constants instead of hardcoding paths to keep references in sync.
 */
export const DOC_REFS = {
  appRoot: APP_ROOT,
  sources: `${APP_ROOT}/docs/sources.md`,
  permissions: `${APP_ROOT}/docs/permissions.md`,
  skills: `${APP_ROOT}/docs/skills.md`,
  themes: `${APP_ROOT}/docs/themes.md`,
  statuses: `${APP_ROOT}/docs/statuses.md`,
  labels: `${APP_ROOT}/docs/labels.md`,
  toolIcons: `${APP_ROOT}/docs/tool-icons.md`,
  automations: `${APP_ROOT}/docs/automations.md`,
  hooks: `${APP_ROOT}/docs/automations.md`,
  tasks: `${APP_ROOT}/docs/automations.md`,
  mermaid: `${APP_ROOT}/docs/mermaid.md`,
  dataTables: `${APP_ROOT}/docs/data-tables.md`,
  htmlPreview: `${APP_ROOT}/docs/html-preview.md`,
  pdfPreview: `${APP_ROOT}/docs/pdf-preview.md`,
  imagePreview: `${APP_ROOT}/docs/image-preview.md`,
  markdownPreview: `${APP_ROOT}/docs/markdown-preview.md`,
  llmTool: `${APP_ROOT}/docs/llm-tool.md`,
  browserTools: `${APP_ROOT}/docs/browser-tools.md`,
  craftCli: `${APP_ROOT}/docs/vorno-cli.md`,
  docsDir: `${APP_ROOT}/docs/`,
  // Directory, not per-service files. There are ~16 service guides and the system
  // prompt is not the place to enumerate them — the agent lists the directory when
  // it is actually setting up a source.
  sourceGuides: `${APP_ROOT}/docs/sources/`,
} as const;

/**
 * Check if docs directory exists
 */
export function docsExist(): boolean {
  return existsSync(DOCS_DIR);
}

/**
 * List available doc files
 */
export function listDocs(): string[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
}

/**
 * Initialize docs directory with bundled documentation.
 * Always writes all docs on launch to ensure consistency across debug and release modes.
 */
export function initializeDocs(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (docsInitialized) {
    return;
  }
  docsInitialized = true;

  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  // Load bundled docs lazily (after setBundledAssetsRoot has been called)
  const loaded = getLoadedBundledDocs();
  const bundledDocs = loaded.docs;

  // Always write bundled docs to disk on launch.
  // This ensures consistent behavior between debug and release modes —
  // docs are always up-to-date with the running version.
  for (const [filename, content] of Object.entries(bundledDocs)) {
    const docPath = join(DOCS_DIR, filename);
    // Subdirectory keys (sources/github.md) need their parent created first.
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, content, 'utf-8');
  }

  reconcileDocsDir(loaded);

  debug(`[docs] Synced ${Object.keys(bundledDocs).length} docs`);
}

/**
 * Top-level prefix reserved for user-authored docs. Anything under
 * `<docs>/local/` is never written or deleted by the sync, so offline notes and
 * power-user copies survive every upgrade. Everything else in the docs dir is
 * owned by the build and reconciled to match exactly what it ships.
 */
const USER_DOCS_PREFIX = 'local';

/**
 * Reconcile the on-disk docs dir to exactly what this build ships.
 *
 * Writing the bundled docs is not enough: the agent reads this directory to set
 * sources up, and a guide renamed or dropped in a later build would otherwise
 * linger from an earlier install. A setup guide naming a dead OAuth console path
 * or a renamed scope is worse than no guide — it sends the agent down a path that
 * only fails at credential time. So after writing, we delete what the build no
 * longer ships, recursively (a stale `sources/<service>.md` is the whole point,
 * but a renamed top-level doc must go too).
 *
 * Deleting user-visible files is the part to get right. Two invariants keep this
 * from becoming data loss:
 *
 *  - Reconcile against the *shipped manifest*, never a wildcard. If that manifest
 *    is empty or was read incompletely, skip the entire pass — an unexpected
 *    empty/partial manifest must never wipe the directory.
 *  - Anything under `local/` is the user's and is left untouched, so offline and
 *    power-user copies keep working.
 */
function reconcileDocsDir(loaded: LoadedBundledDocs): void {
  if (!existsSync(DOCS_DIR)) return;

  // A partial read may be missing docs this build actually ships; deleting their
  // on-disk copies would be the exact failure we're guarding against. Written
  // docs already landed above — only deletion has to fail safe.
  if (!loaded.complete) {
    debug('[docs] Skipping reconcile: bundled manifest read incompletely');
    return;
  }

  const shipped = new Set(Object.keys(loaded.docs));
  if (shipped.size === 0) {
    // Empty manifest — almost certainly a broken/missing bundle, not a build that
    // genuinely ships zero docs. Never let it empty the directory.
    debug('[docs] Skipping reconcile: bundled manifest is empty');
    return;
  }

  let removed = 0;
  const walk = (dirRel: string): void => {
    const abs = dirRel ? join(DOCS_DIR, dirRel) : DOCS_DIR;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      console.error(`[docs] Could not read ${abs} during reconcile:`, error);
      return;
    }
    for (const entry of entries) {
      // POSIX-style key ("sources/github.md") to match the shipped manifest.
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;

      // Never touch the user's namespace.
      if (rel === USER_DOCS_PREFIX || rel.startsWith(`${USER_DOCS_PREFIX}/`)) continue;

      if (entry.isDirectory()) {
        const childAbs = join(abs, entry.name);
        walk(rel);
        // Drop a directory the build no longer populates (e.g. a whole retired
        // guide subdir), but only once it's empty — never blind-recursive-delete.
        try {
          if (readdirSync(childAbs).length === 0) rmSync(childAbs, { recursive: true });
        } catch {
          // Non-empty or already gone — leave it.
        }
        continue;
      }

      if (shipped.has(rel)) continue;
      try {
        rmSync(join(abs, entry.name));
        removed++;
      } catch (error) {
        console.error(`[docs] Failed to prune stale doc ${rel}:`, error);
      }
    }
  };
  walk('');

  if (removed > 0) debug(`[docs] Reconciled docs dir: removed ${removed} stale file(s)`);
}

// Export the lazy getter for external access
export { getBundledDocs };

/**
 * Drop the once-per-process guards so docs re-sync on the next initializeDocs().
 *
 * Test-only. `docsInitialized` and the `_bundledDocs` cache exist to stop hot
 * reload re-running the sync, but they also mean the first module to call
 * initializeDocs() in a process decides what every later caller sees — in the
 * shared suite that is `config/storage.ts`, long before any docs test runs.
 * Without this, a docs test passes alone and silently no-ops in a full run.
 */
export function resetDocsSyncForTests(): void {
  docsInitialized = false;
  _loaded = null;
}

// Re-export source guides utilities (parsing only - bundled guides removed)
export {
  parseSourceGuide,
  getSourceGuide,
  getSourceGuideForDomain,
  getSourceKnowledge,
  extractDomainFromSource,
  extractDomainFromUrl,
  type ParsedSourceGuide,
  type SourceGuideFrontmatter,
} from './source-guides.ts';

// Re-export doc links (for UI help popovers)
export {
  getDocUrl,
  getDocInfo,
  DOCS,
  type DocFeature,
  type DocInfo,
} from './doc-links.ts';
