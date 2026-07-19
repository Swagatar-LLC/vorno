/**
 * Review Workbench artifact index + read (ADR-0014, PLAN-024)
 *
 * The index is computed on demand (no persistent index in v0.1). It scans:
 *   (a) each configured corpusRoot recursively for *.md files
 *   (b) session artifacts: {workspaceRoot}/sessions/<id>/plans/*.md and
 *       {workspaceRoot}/sessions/<id>/data/ **\/*.md
 *   (c) explicitly pinned artifactUris
 *
 * `readArtifact` enforces a hard containment boundary: the realpath of the
 * requested uri must resolve inside a corpusRoot, the workspace sessions/ dir,
 * or exactly match a pinned artifactUri. Reads outside are rejected (null).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { debug } from '../utils/debug.ts';
import type {
  ArtifactRef,
  ArtifactVersion,
  WorkbenchInstanceV1,
} from '@craft-agent/core/types';

// Recursion / volume caps — keep an index scan bounded and cheap.
const CORPUS_DEPTH_CAP = 6;
const SESSION_DATA_DEPTH_CAP = 3;
const GLOBAL_FILE_CAP = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

interface ScanState {
  files: string[];
  truncated: boolean;
}

/** Read the first `# ` heading (stripping leading #s) or fall back to filename. */
function deriveTitle(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        const title = trimmed.replace(/^#+\s*/, '').trim();
        if (title) return title;
      }
    }
  } catch (error) {
    debug('[workbench] Failed to read title:', filePath, error);
  }
  return basename(filePath);
}

function makeRef(
  filePath: string,
  kind: ArtifactRef['kind'],
  sessionId?: string,
): ArtifactRef | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return null;
    return {
      uri: filePath,
      kind,
      title: deriveTitle(filePath),
      sessionId,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  } catch (error) {
    debug('[workbench] Failed to stat artifact:', filePath, error);
    return null;
  }
}

/**
 * Recursively collect `*.md` files under `dir`, honoring the depth cap, skipping
 * node_modules/.git/dotdirs, and stopping at the global file cap (sets
 * `state.truncated`). Throws only if the top-level dir cannot be read — callers
 * treat that as a skipped root.
 */
function scanMarkdown(dir: string, depth: number, depthCap: number, state: ScanState): void {
  if (depth > depthCap) return;
  if (state.files.length >= GLOBAL_FILE_CAP) {
    state.truncated = true;
    return;
  }

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Unreadable subdir mid-walk — skip it, don't sink the whole scan. The
    // top-level unreadable case is handled by the caller (skippedRoots).
    if (depth === 0) throw error;
    debug('[workbench] Skipping unreadable dir:', dir, error);
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
      scanMarkdown(join(dir, name), depth + 1, depthCap, state);
    } else if (entry.isFile() && name.endsWith('.md')) {
      state.files.push(join(dir, name));
    }
  }
}

/**
 * Index all artifacts visible to a workbench instance. Missing/unreadable roots
 * are surfaced in `skippedRoots` (never thrown). A root truncated by the global
 * file cap is recorded as `<root> (truncated)`.
 */
export function indexArtifacts(
  workspaceRoot: string,
  instance: WorkbenchInstanceV1,
): { artifacts: ArtifactRef[]; skippedRoots: string[] } {
  const artifacts: ArtifactRef[] = [];
  const skippedRoots: string[] = [];
  const seen = new Set<string>();

  const pushRef = (ref: ArtifactRef | null) => {
    if (!ref) return;
    if (seen.has(ref.uri)) return;
    seen.add(ref.uri);
    artifacts.push(ref);
  };

  // (a) corpus roots
  for (const root of instance.corpusRoots) {
    const state: ScanState = { files: [], truncated: false };
    try {
      scanMarkdown(root, 0, CORPUS_DEPTH_CAP, state);
    } catch (error) {
      debug('[workbench] Skipping corpus root:', root, error);
      skippedRoots.push(root);
      continue;
    }
    if (state.truncated) skippedRoots.push(`${root} (truncated)`);
    for (const file of state.files) pushRef(makeRef(file, 'corpus'));
  }

  // (b) session artifacts: sessions/<id>/plans/*.md and sessions/<id>/data/**/*.md
  const sessionsDir = join(workspaceRoot, 'sessions');
  if (existsSync(sessionsDir)) {
    let sessionEntries: import('fs').Dirent[] = [];
    try {
      sessionEntries = readdirSync(sessionsDir, { withFileTypes: true });
    } catch (error) {
      debug('[workbench] Skipping sessions dir:', sessionsDir, error);
      skippedRoots.push(sessionsDir);
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      const sessionDir = join(sessionsDir, sessionId);

      // plans/*.md (one level)
      const plansDir = join(sessionDir, 'plans');
      if (existsSync(plansDir)) {
        try {
          for (const planEntry of readdirSync(plansDir, { withFileTypes: true })) {
            if (planEntry.isFile() && planEntry.name.endsWith('.md')) {
              pushRef(makeRef(join(plansDir, planEntry.name), 'session-plan', sessionId));
            }
          }
        } catch (error) {
          debug('[workbench] Skipping session plans dir:', plansDir, error);
        }
      }

      // data/**/*.md (depth-capped)
      const dataDir = join(sessionDir, 'data');
      if (existsSync(dataDir)) {
        const state: ScanState = { files: [], truncated: false };
        try {
          scanMarkdown(dataDir, 0, SESSION_DATA_DEPTH_CAP, state);
        } catch (error) {
          debug('[workbench] Skipping session data dir:', dataDir, error);
          state.files = [];
        }
        if (state.truncated) skippedRoots.push(`${dataDir} (truncated)`);
        for (const file of state.files) pushRef(makeRef(file, 'session-data', sessionId));
      }
    }
  }

  // (c) pinned artifactUris
  for (const uri of instance.artifactUris) {
    if (!existsSync(uri)) {
      skippedRoots.push(uri);
      continue;
    }
    // A pinned uri already indexed via corpus/session keeps its original kind.
    if (!seen.has(uri)) pushRef(makeRef(uri, 'corpus'));
  }

  return { artifacts, skippedRoots };
}

/**
 * Realpath a path, returning null when it does not resolve (missing/broken).
 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when `realTarget` is inside `realRoot` (or equal to it). Both must be
 * realpathed already. Uses a path-segment guard so `/a/roots` is not treated as
 * inside `/a/root`.
 */
function isInside(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true;
  const withSep = realRoot.endsWith('/') ? realRoot : realRoot + '/';
  return realTarget.startsWith(withSep);
}

/**
 * Enforce the containment trust boundary for a read. Returns the realpath of the
 * target when it is allowed, else null. The target must resolve inside a
 * realpathed corpusRoot, the realpathed workspace sessions/ dir, or exactly
 * equal a realpathed pinned artifactUri.
 */
export function resolveContainedArtifact(
  workspaceRoot: string,
  instance: WorkbenchInstanceV1,
  uri: string,
): string | null {
  const realTarget = tryRealpath(uri);
  if (!realTarget) return null;

  // corpus roots
  for (const root of instance.corpusRoots) {
    const realRoot = tryRealpath(root);
    if (realRoot && isInside(realRoot, realTarget)) return realTarget;
  }

  // workspace sessions/ dir
  const realSessions = tryRealpath(join(workspaceRoot, 'sessions'));
  if (realSessions && isInside(realSessions, realTarget)) return realTarget;

  // pinned artifactUris (exact match only)
  for (const pinned of instance.artifactUris) {
    const realPinned = tryRealpath(pinned);
    if (realPinned && realPinned === realTarget) return realTarget;
  }

  return null;
}

/** SHA-256 hex of a file's bytes. */
export function computeContentHash(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Best-effort git HEAD SHA for the file's directory. Fail-soft to undefined
 * (untracked file, no git, timeout) — a missing gitSha is never an error.
 */
function getGitSha(fileDir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', fileDir, 'rev-parse', 'HEAD'],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const sha = stdout.trim();
        resolve(sha || undefined);
      },
    );
  });
}

export interface ReadArtifactResult {
  ref: ArtifactRef;
  content: string;
  version: ArtifactVersion;
}

/**
 * Read an artifact after enforcing containment. Returns null when the uri is
 * denied (outside all roots) or the file cannot be read — the handler cannot
 * distinguish the two here (both surface as not-found/denied to the caller).
 */
export async function readArtifact(
  workspaceRoot: string,
  instance: WorkbenchInstanceV1,
  uri: string,
): Promise<ReadArtifactResult | null> {
  const realTarget = resolveContainedArtifact(workspaceRoot, instance, uri);
  if (!realTarget) return null;

  let content: string;
  let ref: ArtifactRef | null;
  let contentHash: string;
  try {
    content = readFileSync(realTarget, 'utf-8');
    contentHash = computeContentHash(realTarget);
    ref = makeRef(realTarget, 'corpus');
  } catch (error) {
    debug('[workbench] Failed to read artifact:', realTarget, error);
    return null;
  }
  if (!ref) return null;

  const gitSha = await getGitSha(dirname(realTarget));
  const version: ArtifactVersion = { contentHash, gitSha };
  return { ref, content, version };
}
