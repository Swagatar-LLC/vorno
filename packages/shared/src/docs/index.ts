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

/**
 * Load bundled docs from asset files.
 * Called once at module initialization.
 * Returns empty strings if files don't exist (graceful degradation).
 */
function loadBundledDocs(): Record<string, string> {
  const assetsDir = getAssetsDir();
  const docs: Record<string, string> = {};

  // Auto-discover all files in the bundled docs directory, including one level of
  // subdirectories (docs/sources/*.md holds the per-service setup guides).
  // No hardcoded list — any file dropped into resources/docs/ is synced automatically.
  // Keys are paths relative to assetsDir, so a subdirectory key is "sources/github.md".
  let entries: Dirent[];
  try {
    entries = existsSync(assetsDir) ? readdirSync(assetsDir, { withFileTypes: true }) : [];
  } catch {
    console.warn(`[docs] Could not read assets dir: ${assetsDir}`);
    return docs;
  }

  for (const entry of entries) {
    const entryPath = join(assetsDir, entry.name);
    if (entry.isDirectory()) {
      // Nested docs (e.g. sources/). One level only — deeper nesting has no use
      // case and would just be a way to hide docs from the sync.
      let nested: string[];
      try {
        nested = readdirSync(entryPath);
      } catch (error) {
        console.error(`[docs] Failed to read ${entry.name}/:`, error);
        continue;
      }
      for (const filename of nested) {
        const key = `${entry.name}/${filename}`;
        try {
          docs[key] = readFileSync(join(entryPath, filename), 'utf-8');
        } catch (error) {
          console.error(`[docs] Failed to load ${key}:`, error);
        }
      }
      continue;
    }
    try {
      docs[entry.name] = readFileSync(entryPath, 'utf-8');
    } catch (error) {
      console.error(`[docs] Failed to load ${entry.name}:`, error);
    }
  }

  return docs;
}

// Lazy-loaded bundled docs cache.
// IMPORTANT: Must NOT load at module initialization because setBundledAssetsRoot()
// hasn't been called yet. Loading eagerly causes empty docs on fresh install.
let _bundledDocs: Record<string, string> | null = null;

/**
 * Get bundled docs, loading them lazily on first access.
 * This ensures docs are loaded AFTER setBundledAssetsRoot() has been called.
 */
function getBundledDocs(): Record<string, string> {
  if (_bundledDocs === null) {
    _bundledDocs = loadBundledDocs();
  }
  return _bundledDocs;
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
  const bundledDocs = getBundledDocs();

  // Always write bundled docs to disk on launch.
  // This ensures consistent behavior between debug and release modes —
  // docs are always up-to-date with the running version.
  for (const [filename, content] of Object.entries(bundledDocs)) {
    const docPath = join(DOCS_DIR, filename);
    // Subdirectory keys (sources/github.md) need their parent created first.
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, content, 'utf-8');
  }

  pruneStaleSourceGuides(bundledDocs);

  debug(`[docs] Synced ${Object.keys(bundledDocs).length} docs`);
}

/**
 * Remove service guides that are no longer bundled.
 *
 * The sync is otherwise write-only, so a guide deleted or renamed upstream would
 * linger in the user's docs dir forever — and a setup guide naming a dead OAuth
 * console path or a retired endpoint is worse than no guide at all, because the
 * agent follows it confidently until it fails at credential time.
 *
 * Deliberately scoped to docs/sources/ only. The top level of DOCS_DIR is a
 * directory users can drop their own files into; pruning it would turn a docs
 * sync into silent data loss. docs/sources/ is wholly ours and did not exist
 * before the guides did, so nothing user-authored can be in it.
 */
function pruneStaleSourceGuides(bundledDocs: Record<string, string>): void {
  const guidesDir = join(DOCS_DIR, 'sources');
  if (!existsSync(guidesDir)) return;

  const bundled = new Set(
    Object.keys(bundledDocs)
      .filter((key) => key.startsWith('sources/'))
      .map((key) => key.slice('sources/'.length)),
  );

  let removed = 0;
  try {
    for (const filename of readdirSync(guidesDir)) {
      if (bundled.has(filename)) continue;
      try {
        rmSync(join(guidesDir, filename), { recursive: true });
        removed++;
      } catch (error) {
        console.error(`[docs] Failed to prune stale guide sources/${filename}:`, error);
      }
    }
  } catch (error) {
    console.error('[docs] Could not prune stale source guides:', error);
    return;
  }

  if (removed > 0) debug(`[docs] Pruned ${removed} stale source guide(s)`);
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
  _bundledDocs = null;
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
