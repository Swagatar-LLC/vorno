/**
 * Obsidian-vault projection (ADR-0016; PLAN-025 C1).
 *
 * Copies a selected set of artifacts (by URI) into a destination directory,
 * preserving `<rootId>/<relPath>` structure so relative links between exported
 * notes keep resolving. Each URI passes the same containment + admissibility gate
 * as read.ts. Denials are collected in `skipped` with a reason string.
 *
 * // ponytail: plain copy is the v1 projection; frontmatter enrichment when a
 * // consumer demands it.
 */

import { copyFileSync, mkdirSync, statSync } from 'fs';
import { dirname, extname, join } from 'path';
import { debug } from '../utils/debug.ts';
import { parseArtifactUri } from './uri.ts';
import { resolveArtifactPath, resolveRootBindings } from './roots.ts';
import { getRegisteredExtensions } from './registry.ts';
import { getArtifactState } from './store.ts';

// ponytail: mirrors read.ts flat cap — a projection is a batch of reads.
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface ExportObsidianVaultOptions {
  workspaceRootPath: string;
  configuredRoots?: Record<string, string>;
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
export function exportObsidianVault(
  options: ExportObsidianVaultOptions,
): ExportObsidianVaultResult {
  const { workspaceRootPath, configuredRoots, uris, destDir } = options;
  const bindings = resolveRootBindings(workspaceRootPath, configuredRoots);
  const registeredExtensions = getRegisteredExtensions();
  const state = getArtifactState(workspaceRootPath);

  const exported: string[] = [];
  const skipped: string[] = [];

  for (const uri of uris) {
    const parsed = parseArtifactUri(uri);
    if (!parsed) {
      skipped.push(`${uri}: invalid-uri`);
      continue;
    }

    const resolved = resolveArtifactPath(uri, bindings);
    if (!resolved) {
      skipped.push(`${uri}: containment-denied`);
      continue;
    }
    const { absPath } = resolved;

    // Same admissibility gate as read.ts: registered extension OR pinned.
    const ext = extname(absPath).toLowerCase();
    if (!registeredExtensions.has(ext) && state[uri]?.pinned !== true) {
      skipped.push(`${uri}: unregistered-type`);
      continue;
    }

    try {
      const stats = statSync(absPath);
      if (!stats.isFile()) {
        skipped.push(`${uri}: not-a-file`);
        continue;
      }
      if (stats.size > MAX_ARTIFACT_BYTES) {
        skipped.push(`${uri}: too-large`);
        continue;
      }
      const target = join(destDir, parsed.rootId, parsed.relPath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(absPath, target);
      exported.push(uri);
    } catch (error) {
      debug('[artifacts] Failed to export artifact:', uri, error);
      skipped.push(`${uri}: copy-failed`);
    }
  }

  return { exported, skipped };
}
