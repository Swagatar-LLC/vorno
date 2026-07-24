/**
 * Zero-config, context-aware artifact index (ADR-0016, PLAN-025 C1).
 *
 * Generalizes the workbench markdown scan. Sources:
 *   (1) the `workspace` root: sessions/<id>/plans/** and sessions/<id>/data/**
 *       → origin kind 'session-plan' / 'session-data', stamped with sessionId
 *       (and joined session context).
 *   (2) each configured root, scanned recursively → origin kind 'corpus'.
 *
 * The file filter is the registered-extension set (not `.md`-only). Markdown
 * frontmatter contributes title/tags/metadata (never type). Session context
 * (projectId, labels, status) is joined once per call from listSessions().
 *
 * Caps carry over from workbench/artifacts.ts: recursion depth caps, SKIP_DIRS,
 * GLOBAL_FILE_CAP. Roots the scan cannot (fully) serve are surfaced as
 * `ArtifactSkippedRoot` — rootId + reason only, never absolute paths
 * (ADR-0016 §2 door 2).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import matter from 'gray-matter';
import { debug } from '../utils/debug.ts';
import { listSessions } from '../sessions/storage.ts';
import type {
  ArtifactEntry,
  ArtifactOrigin,
  ArtifactOriginKind,
  ArtifactRootsConfig,
  ArtifactSkippedRoot,
} from '@craft-agent/core/types';
import { getArtifactTypeForPath, getRegisteredExtensions } from './registry.ts';
import { resolveRootBindings, absPathToUri, type RootBinding } from './roots.ts';
import { RESERVED_WORKSPACE_ROOT_ID } from './uri.ts';
import { getArtifactState } from './store.ts';

// Recursion / volume caps — keep an index scan bounded and cheap.
const CORPUS_DEPTH_CAP = 6;
const SESSION_DATA_DEPTH_CAP = 3;
const GLOBAL_FILE_CAP = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

interface ScanState {
  files: string[];
  truncated: boolean;
}

export interface IndexArtifactsOptions {
  workspaceRootPath: string;
  configuredRoots?: ArtifactRootsConfig;
  includeArchived?: boolean;
}

/**
 * Recursively collect files whose extension is registered, honoring the depth
 * cap, skipping node_modules/.git/dotdirs, and stopping at the global file cap
 * (sets `state.truncated`). Throws only if the top-level dir cannot be read —
 * callers treat that as a skipped root.
 */
function scanFiles(
  dir: string,
  depth: number,
  depthCap: number,
  extensions: Set<string>,
  state: ScanState,
): void {
  if (depth > depthCap) return;
  if (state.files.length >= GLOBAL_FILE_CAP) {
    state.truncated = true;
    return;
  }

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) throw error;
    debug('[artifacts] Skipping unreadable dir:', dir, error);
    return;
  }

  for (const entry of entries) {
    if (state.files.length >= GLOBAL_FILE_CAP) {
      state.truncated = true;
      return;
    }
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      scanFiles(join(dir, name), depth + 1, depthCap, extensions, state);
    } else if (entry.isFile() && extensions.has(extname(name).toLowerCase())) {
      state.files.push(join(dir, name));
    }
  }
}

/** Session context joined onto origins that carry a sessionId. */
interface SessionContext {
  projectId?: string;
  labels?: string[];
  sessionStatus?: string;
}

/** Build sessionId → context map once per index call (tolerates a missing dir). */
function buildSessionContext(workspaceRootPath: string): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  let sessions: ReturnType<typeof listSessions>;
  try {
    sessions = listSessions(workspaceRootPath);
  } catch (error) {
    debug('[artifacts] Failed to list sessions for context join:', error);
    return map;
  }
  for (const s of sessions) {
    map.set(s.id, {
      projectId: s.projectId,
      labels: s.labels,
      sessionStatus: s.sessionStatus,
    });
  }
  return map;
}

/** Whether a value is a JSON-safe scalar (string/number/boolean/null). */
function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Reduce frontmatter data to a JSON-safe subset: scalars and arrays-of-scalars.
 * Nested objects/mixed arrays are dropped (kept simple + serializable). Returns
 * undefined when nothing survives.
 */
function extractMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isScalar(value)) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every(isScalar)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Extract string[] tags from frontmatter, else undefined. */
function extractTags(data: Record<string, unknown>): string[] | undefined {
  const raw = data.tags;
  if (Array.isArray(raw) && raw.every((t) => typeof t === 'string')) {
    return raw as string[];
  }
  return undefined;
}

/**
 * First ATX heading (`#`–`######` followed by whitespace), else null. A bare
 * `#hashtag` line is not a heading and never becomes a title.
 */
function firstHeading(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^#{1,6}\s+(.*)$/);
    if (match) {
      const title = (match[1] ?? '').trim();
      if (title) return title;
    }
  }
  return null;
}

interface ParsedDoc {
  title: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Derive title/tags/metadata for a file. Markdown gets frontmatter parsing
 * (title precedence: frontmatter `title` > first heading > basename); other
 * registered types use the basename. gray-matter is wrapped in try/catch and
 * never throws — parse failure is treated as no frontmatter.
 */
function parseDoc(filePath: string, content: string): ParsedDoc {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath);

  if (ext === '.md' || ext === '.markdown') {
    try {
      const parsed = matter(content);
      const data = (parsed.data ?? {}) as Record<string, unknown>;
      const fmTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
      const title = fmTitle ?? firstHeading(parsed.content) ?? firstHeading(content) ?? base;
      return { title, tags: extractTags(data), metadata: extractMetadata(data) };
    } catch (error) {
      debug('[artifacts] Frontmatter parse failed — treating as none:', filePath, error);
      return { title: firstHeading(content) ?? base };
    }
  }

  // .canvas / .json / other registered types: basename title, no frontmatter.
  return { title: base };
}

/**
 * Build an ArtifactEntry for a scanned absolute path. Returns null when the file
 * cannot be statted/read or has no addressable URI under the given bindings.
 */
function makeEntry(
  absPath: string,
  originKind: ArtifactOriginKind,
  bindings: Map<string, RootBinding>,
  sessionId: string | undefined,
  sessionCtx: Map<string, SessionContext>,
  state: Record<string, import('./store.ts').ArtifactStateEntry>,
): ArtifactEntry | null {
  let stats: import('fs').Stats;
  let content: string;
  try {
    stats = statSync(absPath);
    if (!stats.isFile()) return null;
    // Scanned files are text-type by extension registration in C1.
    content = readFileSync(absPath, 'utf-8');
  } catch (error) {
    debug('[artifacts] Failed to read scanned file:', absPath, error);
    return null;
  }

  const uri = absPathToUri(absPath, bindings);
  if (!uri) return null;

  const { title, tags, metadata } = parseDoc(absPath, content);

  const origin: ArtifactOrigin = { kind: originKind };
  if (sessionId) {
    origin.sessionId = sessionId;
    const ctx = sessionCtx.get(sessionId);
    if (ctx) {
      if (ctx.projectId) origin.projectId = ctx.projectId;
      if (ctx.labels) origin.labels = ctx.labels;
      if (ctx.sessionStatus) origin.sessionStatus = ctx.sessionStatus;
    }
  }

  const lifecycle = state[uri];
  const entry: ArtifactEntry = {
    uri,
    type: getArtifactTypeForPath(absPath),
    origin,
    title,
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
  };
  if (tags) entry.tags = tags;
  if (metadata) entry.metadata = metadata;
  if (lifecycle?.pinned) entry.pinned = true;
  if (lifecycle?.archived) entry.archived = true;
  return entry;
}

/** A file surfaced by the scan, before entry construction. */
interface ScannedFile {
  absPath: string;
  originKind: ArtifactOriginKind;
  sessionId?: string;
}

/**
 * The shared scan stage: walk session plans/data + configured roots and collect
 * candidate files. No content reads — `indexArtifacts` builds full entries from
 * this, and `indexArtifactUris` builds the read-gate URI set (ADR-0016 §4).
 * Skips are per rootId + reason, deduped, never absolute paths.
 */
function collectScannedFiles(
  workspaceRootPath: string,
  configuredRoots?: ArtifactRootsConfig,
): {
  files: ScannedFile[];
  skippedRoots: ArtifactSkippedRoot[];
  bindings: Map<string, RootBinding>;
} {
  const bindings = resolveRootBindings(workspaceRootPath, configuredRoots);
  const extensions = getRegisteredExtensions();
  const files: ScannedFile[] = [];
  const skipped = new Map<string, ArtifactSkippedRoot>();
  const skip = (rootId: string, reason: ArtifactSkippedRoot['reason']) => {
    skipped.set(`${rootId}:${reason}`, { rootId, reason });
  };

  // (1) workspace root — session plans + data.
  const sessionsDir = join(workspaceRootPath, 'sessions');
  if (existsSync(sessionsDir)) {
    let sessionEntries: import('fs').Dirent[] = [];
    try {
      sessionEntries = readdirSync(sessionsDir, { withFileTypes: true });
    } catch (error) {
      debug('[artifacts] Skipping sessions dir:', sessionsDir, error);
      skip(RESERVED_WORKSPACE_ROOT_ID, 'unreadable');
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      const sessionDir = join(sessionsDir, sessionId);

      const subdirs = [
        { name: 'plans', originKind: 'session-plan' as const },
        { name: 'data', originKind: 'session-data' as const },
      ];
      for (const { name, originKind } of subdirs) {
        const dir = join(sessionDir, name);
        if (!existsSync(dir)) continue;
        const st: ScanState = { files: [], truncated: false };
        try {
          scanFiles(dir, 0, SESSION_DATA_DEPTH_CAP, extensions, st);
        } catch (error) {
          debug('[artifacts] Skipping session subdir:', dir, error);
          st.files = [];
        }
        if (st.truncated) skip(RESERVED_WORKSPACE_ROOT_ID, 'truncated');
        for (const absPath of st.files) {
          files.push({ absPath, originKind, sessionId });
        }
      }
    }
  }

  // (2) configured (non-workspace) roots — corpus.
  for (const [rootId, binding] of bindings) {
    if (rootId === RESERVED_WORKSPACE_ROOT_ID) continue;
    if (binding.kind !== 'filesystem') continue;
    if (!existsSync(binding.path)) {
      skip(rootId, 'missing');
      continue;
    }
    const st: ScanState = { files: [], truncated: false };
    try {
      scanFiles(binding.path, 0, CORPUS_DEPTH_CAP, extensions, st);
    } catch (error) {
      debug('[artifacts] Skipping corpus root:', binding.path, error);
      skip(rootId, 'unreadable');
      continue;
    }
    if (st.truncated) skip(rootId, 'truncated');
    for (const absPath of st.files) {
      files.push({ absPath, originKind: 'corpus' });
    }
  }

  return { files, skippedRoots: Array.from(skipped.values()), bindings };
}

/**
 * Index all artifacts visible to a workspace. Missing/unreadable roots are
 * surfaced in `skippedRoots` (never thrown), identified by rootId + reason —
 * never absolute paths (ADR-0016 §2). Archived artifacts are excluded unless
 * `includeArchived` is set.
 */
export function indexArtifacts(options: IndexArtifactsOptions): {
  artifacts: ArtifactEntry[];
  skippedRoots: ArtifactSkippedRoot[];
} {
  const { workspaceRootPath, configuredRoots, includeArchived } = options;
  const { files, skippedRoots, bindings } = collectScannedFiles(workspaceRootPath, configuredRoots);
  const sessionCtx = buildSessionContext(workspaceRootPath);
  const state = getArtifactState(workspaceRootPath);

  const artifacts: ArtifactEntry[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const entry = makeEntry(f.absPath, f.originKind, bindings, f.sessionId, sessionCtx, state);
    if (!entry) continue;
    if (seen.has(entry.uri)) continue;
    if (entry.archived && !includeArchived) continue;
    seen.add(entry.uri);
    artifacts.push(entry);
  }
  return { artifacts, skippedRoots };
}

/**
 * The read-gate membership set (ADR-0016 §4 door 4): the URIs the index scan
 * surfaces, computed without any content reads. Archived artifacts are
 * included — archival is a lifecycle flag, not a read restriction.
 */
export function indexArtifactUris(options: {
  workspaceRootPath: string;
  configuredRoots?: ArtifactRootsConfig;
}): Set<string> {
  const { files, bindings } = collectScannedFiles(options.workspaceRootPath, options.configuredRoots);
  const uris = new Set<string>();
  for (const f of files) {
    const uri = absPathToUri(f.absPath, bindings);
    if (uri) uris.add(uri);
  }
  return uris;
}
