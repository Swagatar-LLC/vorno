/**
 * Artifact read gate (ADR-0016 §4).
 *
 * `readArtifactByUri` serves an artifact only when ALL hold:
 *   (a) containment — the URI resolves within a registered root (realpath
 *       containment, roots.ts);
 *   (b) admissibility — the URI is a member of the index (the scan surface:
 *       session plans/data + configured roots, registered extensions) OR it is
 *       explicitly pinned in state.json. Read is gated by *index membership*,
 *       not by extension alone — a contained file the index never surfaces is
 *       NOT readable (ADR-0016 §4 door 4);
 *   (c) size cap — the byte size is under the flat cap.
 *
 * Returns null (never throws) on any denial or read failure — the caller cannot
 * distinguish denied from not-found, by design.
 */

import { readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import { debug } from '../utils/debug.ts';
import type { ArtifactVersion } from '@craft-agent/core/types';
import { resolveArtifactPath, resolveRootBindings } from './roots.ts';
import { canonicalizeArtifactUri } from './uri.ts';
import { indexArtifactUris } from './scan.ts';
import { getArtifactState } from './store.ts';
import { computeContentHash, getGitSha } from './content.ts';

// ponytail: flat cap, revisit for binary types in C2. Single definition —
// projection-obsidian.ts imports this.
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MB

export interface ReadArtifactOptions {
  workspaceRootPath: string;
  configuredRoots?: Record<string, string>;
  uri: string;
}

export interface ReadArtifactByUriResult {
  uri: string;
  absPath: string;
  content: string;
  version: ArtifactVersion;
}

/**
 * Resolve + gate + read an artifact by its `vorno-artifact://` URI. See the
 * module header for the full policy. Returns null on any failure.
 */
export async function readArtifactByUri(
  options: ReadArtifactOptions,
): Promise<ReadArtifactByUriResult | null> {
  const { workspaceRootPath, configuredRoots } = options;
  // Canonical spelling only: index/pin membership is string equality, so an
  // RFC 3986-equivalent alias (lowercase hex, over-encoded reserved chars)
  // must collapse to one identity before any lookup (ADR-0016 §1 canonical form).
  const uri = canonicalizeArtifactUri(options.uri);
  if (!uri) return null;
  const bindings = resolveRootBindings(workspaceRootPath, configuredRoots);

  // (a) containment
  const resolved = resolveArtifactPath(uri, bindings);
  if (!resolved) return null;
  const { absPath } = resolved;

  // (b) admissibility: indexed OR explicitly pinned (ADR-0016 §4 door 4 — the
  // index is the read surface; pinning is the deliberate escape hatch).
  // ponytail: membership re-scans per read (path walk only, no content reads,
  // capped at GLOBAL_FILE_CAP); cache behind this predicate if it measures hot.
  const indexed = indexArtifactUris({ workspaceRootPath, configuredRoots }).has(uri);
  if (!indexed) {
    const pinned = getArtifactState(workspaceRootPath)[uri]?.pinned === true;
    if (!pinned) return null;
  }

  // (c) size cap
  let content: string;
  let contentHash: string;
  try {
    const stats = statSync(absPath);
    if (!stats.isFile()) return null;
    if (stats.size > MAX_ARTIFACT_BYTES) return null;
    content = readFileSync(absPath, 'utf-8');
    contentHash = computeContentHash(absPath);
  } catch (error) {
    debug('[artifacts] Failed to read artifact:', absPath, error);
    return null;
  }

  const gitSha = await getGitSha(dirname(absPath));
  const version: ArtifactVersion = { contentHash, gitSha };
  return { uri, absPath, content, version };
}
