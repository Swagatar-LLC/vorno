/**
 * Artifact read gate (ADR-0016 §4).
 *
 * `readArtifactByUri` serves an artifact only when ALL hold:
 *   (a) containment — the URI resolves within a registered root (realpath
 *       containment, roots.ts);
 *   (b) admissibility — its extension is registered OR it is explicitly pinned
 *       in state.json (opening beyond `.md` widens reads only to the registry
 *       plus deliberate pins, never to "anything within a root");
 *   (c) size cap — the byte size is under the flat cap.
 *
 * Returns null (never throws) on any denial or read failure — the caller cannot
 * distinguish denied from not-found, by design.
 */

import { readFileSync, statSync } from 'fs';
import { dirname, extname } from 'path';
import { debug } from '../utils/debug.ts';
import type { ArtifactVersion } from '@craft-agent/core/types';
import { resolveArtifactPath, resolveRootBindings } from './roots.ts';
import { getRegisteredExtensions } from './registry.ts';
import { getArtifactState } from './store.ts';
import { computeContentHash, getGitSha } from './content.ts';

// ponytail: flat cap, revisit for binary types in C2.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MB

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
  const { workspaceRootPath, configuredRoots, uri } = options;
  const bindings = resolveRootBindings(workspaceRootPath, configuredRoots);

  // (a) containment
  const resolved = resolveArtifactPath(uri, bindings);
  if (!resolved) return null;
  const { absPath } = resolved;

  // (b) admissibility: registered extension OR explicitly pinned.
  const ext = extname(absPath).toLowerCase();
  const extensionRegistered = getRegisteredExtensions().has(ext);
  if (!extensionRegistered) {
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
