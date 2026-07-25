/**
 * Zero-config, context-aware artifact index (ADR-0016, ADR-0018, PLAN-025 C1).
 *
 * Generalizes the workbench markdown scan. Sources:
 *   (1) the `workspace` root: sessions/<id>/plans/** and sessions/<id>/data/**
 *       → origin kind 'session-plan' / 'session-data', stamped with sessionId
 *       (and joined session context).
 *   (2) each configured root, scanned recursively → origin kind 'corpus'.
 *
 * All enumeration and reads go through each root's StorageProvider (ADR-0018
 * door 2) — this module never touches an absolute path. The shape bounds
 * (depth caps, skipped dir names) are imported from admissibility.ts so the
 * scan surface and the read gate agree by construction. `GLOBAL_FILE_CAP` is
 * a LISTING bound only — it never gates readability (ADR-0018 door 1).
 *
 * The file filter is the registered-extension set (not `.md`-only). Markdown
 * frontmatter contributes title/tags/metadata (never type). Session context
 * (projectId, labels, status) is joined once per call from listSessions().
 * Roots the scan cannot (fully) serve are surfaced as `ArtifactSkippedRoot` —
 * rootId + reason only, never absolute paths (ADR-0016 §2 door 2).
 */

import { basename, extname } from 'path';
import matter from 'gray-matter';
import { debug } from '../utils/debug.ts';
import { listSessions } from '../sessions/storage.ts';
import type {
  ArtifactEntry,
  ArtifactOrigin,
  ArtifactOriginKind,
  ArtifactSkippedRoot,
} from '@craft-agent/core/types';
import { getArtifactTypeForPath, getRegisteredExtensions } from './registry.ts';
import { resolveRootBindings } from './roots.ts';
import { RESERVED_WORKSPACE_ROOT_ID, parseArtifactUri } from './uri.ts';
import { getArtifactState } from './store.ts';
import {
  CORPUS_DEPTH_CAP,
  SESSION_DATA_DEPTH_CAP,
  isSkippedDirName,
} from './admissibility.ts';
import { StorageOpError, type ArtifactMeta, type StorageProvider } from './storage/provider.ts';

/** Listing volume bound (per walk unit) — never gates readability (ADR-0018). */
const GLOBAL_FILE_CAP = 2000;

export interface IndexArtifactsOptions {
  workspaceRootPath: string;
  configuredRoots?: Record<string, string>;
  includeArchived?: boolean;
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
 * Derive title/tags/metadata for a markdown body (title precedence: frontmatter
 * `title` > first heading > basename). gray-matter is wrapped in try/catch and
 * never throws — parse failure is treated as no frontmatter.
 */
function parseMarkdownDoc(relPath: string, content: string): ParsedDoc {
  const base = basename(relPath);
  try {
    const parsed = matter(content);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const fmTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
    const title = fmTitle ?? firstHeading(parsed.content) ?? firstHeading(content) ?? base;
    return { title, tags: extractTags(data), metadata: extractMetadata(data) };
  } catch (error) {
    debug('[artifacts] Frontmatter parse failed — treating as none:', relPath, error);
    return { title: firstHeading(content) ?? base };
  }
}

/** A file surfaced by the scan, before entry construction. */
interface ScannedFile {
  uri: string;
  relPath: string;
  originKind: ArtifactOriginKind;
  sessionId?: string;
  sizeBytes: number;
  mtimeMs?: number;
}

/**
 * Build an ArtifactEntry for a scanned file. Markdown content is read through
 * the provider for title/frontmatter (other registered types use the basename
 * — no content read). Returns null when a markdown read fails.
 */
async function makeEntry(
  f: ScannedFile,
  provider: StorageProvider,
  sessionCtx: Map<string, SessionContext>,
  state: Record<string, import('./store.ts').ArtifactStateEntry>,
): Promise<ArtifactEntry | null> {
  const ext = extname(f.relPath).toLowerCase();
  let doc: ParsedDoc;
  if (ext === '.md' || ext === '.markdown') {
    const read = await provider.read(f.uri);
    if (!read.ok) {
      debug('[artifacts] Failed to read scanned file:', f.uri, read.error.kind);
      return null;
    }
    doc = parseMarkdownDoc(f.relPath, read.value.bytes.toString('utf-8'));
  } else {
    // .canvas / .json / other registered types: basename title, no frontmatter.
    doc = { title: basename(f.relPath) };
  }

  const origin: ArtifactOrigin = { kind: f.originKind };
  if (f.sessionId) {
    origin.sessionId = f.sessionId;
    const ctx = sessionCtx.get(f.sessionId);
    if (ctx) {
      if (ctx.projectId) origin.projectId = ctx.projectId;
      if (ctx.labels) origin.labels = ctx.labels;
      if (ctx.sessionStatus) origin.sessionStatus = ctx.sessionStatus;
    }
  }

  const lifecycle = state[f.uri];
  const entry: ArtifactEntry = {
    uri: f.uri,
    type: getArtifactTypeForPath(f.relPath),
    origin,
    title: doc.title,
    mtimeMs: f.mtimeMs ?? 0,
    sizeBytes: f.sizeBytes,
  };
  if (doc.tags) entry.tags = doc.tags;
  if (doc.metadata) entry.metadata = doc.metadata;
  if (lifecycle?.pinned) entry.pinned = true;
  if (lifecycle?.archived) entry.archived = true;
  return entry;
}

/** Prune predicate for the workspace walk (rooted at `sessions/`). */
function workspaceSkipDir(relPath: string): boolean {
  const segments = relPath.split('/');
  // sessions/<id> — session ids are not name-filtered.
  if (segments.length === 2) return false;
  // sessions/<id>/<sub> — only plans/ and data/ are scan surface.
  if (segments.length === 3) return segments[2] !== 'plans' && segments[2] !== 'data';
  return isSkippedDirName(segments[segments.length - 1]!);
}

/** Prune predicate for a corpus-root walk. */
function corpusSkipDir(relPath: string): boolean {
  return isSkippedDirName(relPath.slice(relPath.lastIndexOf('/') + 1));
}

const SESSION_FILE_RE = /^sessions\/([^/]+)\/(plans|data)\//;

/**
 * The shared scan stage: walk session plans/data + configured roots through
 * each root's provider and collect candidate files. Markdown content is not
 * read here — `indexArtifacts` builds full entries from this, and
 * `indexArtifactUris` builds the read-surface URI set. Skips are per rootId +
 * reason, deduped, never absolute paths.
 */
async function collectScannedFiles(
  workspaceRootPath: string,
  configuredRoots?: Record<string, string>,
): Promise<{
  files: ScannedFile[];
  skippedRoots: ArtifactSkippedRoot[];
  providers: Map<string, StorageProvider>;
}> {
  const providers = resolveRootBindings(workspaceRootPath, configuredRoots);
  const extensions = getRegisteredExtensions();
  const files: ScannedFile[] = [];
  const skipped = new Map<string, ArtifactSkippedRoot>();
  const skip = (rootId: string, reason: ArtifactSkippedRoot['reason']) => {
    skipped.set(`${rootId}:${reason}`, { rootId, reason });
  };
  const registered = (meta: ArtifactMeta) => {
    const relPath = parseArtifactUri(meta.uri)?.relPath;
    if (!relPath) return null;
    return extensions.has(extname(relPath).toLowerCase()) ? relPath : null;
  };

  // (1) workspace root — session plans + data. Volume cap applies per
  // session subdir (walk unit), as in the C1 scanner.
  const ws = providers.get(RESERVED_WORKSPACE_ROOT_ID)!;
  const unitCounts = new Map<string, number>();
  try {
    for await (const meta of ws.list({
      prefix: 'sessions',
      maxDepth: 2 + SESSION_DATA_DEPTH_CAP,
      skipDir: workspaceSkipDir,
    })) {
      const relPath = registered(meta);
      if (!relPath) continue;
      const match = relPath.match(SESSION_FILE_RE);
      if (!match) continue;
      const [, sessionId, sub] = match as unknown as [string, string, 'plans' | 'data'];
      const unit = `${sessionId}/${sub}`;
      const count = unitCounts.get(unit) ?? 0;
      if (count >= GLOBAL_FILE_CAP) {
        skip(RESERVED_WORKSPACE_ROOT_ID, 'truncated');
        continue;
      }
      unitCounts.set(unit, count + 1);
      files.push({
        uri: meta.uri,
        relPath,
        originKind: sub === 'plans' ? 'session-plan' : 'session-data',
        sessionId,
        sizeBytes: meta.sizeBytes,
        mtimeMs: meta.mtimeMs,
      });
    }
  } catch (error) {
    // A missing sessions dir is an empty workspace, not a skipped root.
    if (!(error instanceof StorageOpError && error.kind === 'not-found')) {
      debug('[artifacts] Skipping sessions walk:', error);
      skip(RESERVED_WORKSPACE_ROOT_ID, 'unreadable');
    }
  }

  // (2) configured (non-workspace) roots — corpus.
  for (const [rootId, provider] of providers) {
    if (rootId === RESERVED_WORKSPACE_ROOT_ID) continue;
    let count = 0;
    try {
      for await (const meta of provider.list({
        maxDepth: CORPUS_DEPTH_CAP,
        skipDir: corpusSkipDir,
      })) {
        const relPath = registered(meta);
        if (!relPath) continue;
        if (count >= GLOBAL_FILE_CAP) {
          skip(rootId, 'truncated');
          break;
        }
        count++;
        files.push({
          uri: meta.uri,
          relPath,
          originKind: 'corpus',
          sizeBytes: meta.sizeBytes,
          mtimeMs: meta.mtimeMs,
        });
      }
    } catch (error) {
      if (error instanceof StorageOpError && error.kind === 'not-found') {
        skip(rootId, 'missing');
      } else {
        debug('[artifacts] Skipping corpus root:', rootId, error);
        skip(rootId, 'unreadable');
      }
    }
  }

  return { files, skippedRoots: Array.from(skipped.values()), providers };
}

/**
 * Index all artifacts visible to a workspace. Missing/unreadable roots are
 * surfaced in `skippedRoots` (never thrown), identified by rootId + reason —
 * never absolute paths (ADR-0016 §2). Archived artifacts are excluded unless
 * `includeArchived` is set.
 */
export async function indexArtifacts(options: IndexArtifactsOptions): Promise<{
  artifacts: ArtifactEntry[];
  skippedRoots: ArtifactSkippedRoot[];
}> {
  const { workspaceRootPath, configuredRoots, includeArchived } = options;
  const { files, skippedRoots, providers } = await collectScannedFiles(
    workspaceRootPath,
    configuredRoots,
  );
  const sessionCtx = buildSessionContext(workspaceRootPath);
  const state = getArtifactState(workspaceRootPath);

  const artifacts: ArtifactEntry[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const provider = providers.get(parseArtifactUri(f.uri)!.rootId);
    if (!provider) continue;
    const entry = await makeEntry(f, provider, sessionCtx, state);
    if (!entry) continue;
    if (seen.has(entry.uri)) continue;
    if (entry.archived && !includeArchived) continue;
    seen.add(entry.uri);
    artifacts.push(entry);
  }
  return { artifacts, skippedRoots };
}

/**
 * The scan-surface URI set, computed without any content reads. Archived
 * artifacts are included — archival is a lifecycle flag, not a read
 * restriction. NOTE (ADR-0018): this is a listing, not the read gate — the
 * gate is the pure `isAdmissible` predicate in admissibility.ts.
 */
export async function indexArtifactUris(options: {
  workspaceRootPath: string;
  configuredRoots?: Record<string, string>;
}): Promise<Set<string>> {
  const { files } = await collectScannedFiles(options.workspaceRootPath, options.configuredRoots);
  return new Set(files.map((f) => f.uri));
}
