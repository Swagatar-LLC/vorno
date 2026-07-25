/**
 * Obsidian-vault projection (ADR-0016, ADR-0018; PLAN-025 C1).
 *
 * Copies a selected set of artifacts (by URI) into a destination directory,
 * preserving `<rootId>/<relPath>` structure so relative links between exported
 * notes keep resolving. Each URI passes the SAME `isAdmissible` predicate +
 * provider read as read.ts (ADR-0018: one gate, closes SEC-1). Denials are
 * collected in `skipped` with a reason string. The destination is an export
 * target outside the artifact plane — it is written with plain fs.
 *
 * // ponytail: plain copy is the v1 projection; frontmatter enrichment when a
 * // consumer demands it.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ArtifactRootsConfig } from '@craft-agent/core/types';
import { debug } from '../utils/debug.ts';
import { canonicalizeArtifactUri, parseArtifactUri } from './uri.ts';
import { resolveRootBindings } from './roots.ts';
import { isAdmissible, isIndexedLocation } from './admissibility.ts';
import { getArtifactState } from './store.ts';
// A projection is a batch of reads — share read.ts's cap (single definition).
import { MAX_ARTIFACT_BYTES } from './read.ts';

export interface ExportObsidianVaultOptions {
  workspaceRootPath: string;
  configuredRoots?: ArtifactRootsConfig;
  uris: string[];
  destDir: string;
}

export interface ExportObsidianVaultResult {
  /** URIs successfully copied. */
  exported: string[];
  /** `<uri>: <reason>` for each URI that was not copied. */
  skipped: string[];
}

/**
 * Export the given artifact URIs into `destDir`, preserving structure. Content
 * is copied verbatim (no transformation). Never throws — per-URI failures land
 * in `skipped`.
 */
export async function exportObsidianVault(
  options: ExportObsidianVaultOptions,
): Promise<ExportObsidianVaultResult> {
  const { workspaceRootPath, configuredRoots, uris, destDir } = options;
  const providers = resolveRootBindings(workspaceRootPath, configuredRoots);
  const state = getArtifactState(workspaceRootPath);
  const pinned = (u: string) => state[u]?.pinned === true;

  const exported: string[] = [];
  const skipped: string[] = [];

  for (const rawUri of uris) {
    const uri = canonicalizeArtifactUri(rawUri);
    if (!uri) {
      skipped.push(`${rawUri}: invalid-uri`);
      continue;
    }
    const parsed = parseArtifactUri(uri)!;

    const provider = providers.get(parsed.rootId);
    if (!provider) {
      skipped.push(`${uri}: containment-denied`);
      continue;
    }

    // The read gate (ADR-0018 door 1) — identical predicate to read.ts.
    if (!isAdmissible(uri, providers, pinned)) {
      skipped.push(
        isIndexedLocation(parsed.rootId, parsed.relPath)
          ? `${uri}: unregistered-type`
          : `${uri}: not-indexed`,
      );
      continue;
    }

    const read = await provider.read(uri, { maxBytes: MAX_ARTIFACT_BYTES });
    if (!read.ok) {
      skipped.push(
        `${uri}: ${read.error.kind === 'too-large' ? 'too-large' : 'not-found'}`,
      );
      continue;
    }

    try {
      const target = join(destDir, parsed.rootId, parsed.relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, read.value.bytes);
      exported.push(uri);
    } catch (error) {
      debug('[artifacts] Failed to export artifact:', uri, error);
      skipped.push(`${uri}: copy-failed`);
    }
  }

  return { exported, skipped };
}
