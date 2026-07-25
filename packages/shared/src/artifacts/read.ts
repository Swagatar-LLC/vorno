/**
 * Artifact read gate (ADR-0016 §4, ADR-0018).
 *
 * `readArtifactByUri` serves an artifact only when ALL hold:
 *   (a) admissibility — the pure `isAdmissible` predicate (ADR-0018 door 1):
 *       bound root ∧ (indexed location-shape ∧ registered extension, OR
 *       explicitly pinned in state.json). No workspace walk, order-independent.
 *   (b) containment — enforced inside the root's StorageProvider (realpath +
 *       segment guard for the filesystem provider);
 *   (c) size cap — the byte size is under the flat cap, enforced by the
 *       provider read.
 *
 * Returns null (never throws) on any denial or read failure — the caller
 * cannot distinguish denied from not-found, by design.
 */

import type { ArtifactVersion } from '@craft-agent/core/types';
import { resolveRootBindings } from './roots.ts';
import { canonicalizeArtifactUri, parseArtifactUri } from './uri.ts';
import { isAdmissible } from './admissibility.ts';
import { getArtifactState } from './store.ts';

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
  // Canonical spelling only: pin membership is string equality, so an
  // RFC 3986-equivalent alias (lowercase hex, over-encoded reserved chars)
  // must collapse to one identity before any lookup (ADR-0016 §5).
  const uri = canonicalizeArtifactUri(options.uri);
  if (!uri) return null;

  const providers = resolveRootBindings(workspaceRootPath, configuredRoots);
  const provider = providers.get(parseArtifactUri(uri)!.rootId);
  if (!provider) return null;

  const pinned = (u: string) => getArtifactState(workspaceRootPath)[u]?.pinned === true;
  if (!isAdmissible(uri, providers, pinned)) return null;

  const result = await provider.read(uri, { maxBytes: MAX_ARTIFACT_BYTES, withVersion: true });
  if (!result.ok) return null;

  const { bytes, meta } = result.value;
  const version: ArtifactVersion = { contentHash: meta.contentHash!, gitSha: meta.gitSha };
  return { uri, content: bytes.toString('utf-8'), version };
}
