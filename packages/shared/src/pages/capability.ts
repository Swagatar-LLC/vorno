/**
 * Node-only Pages workspace capability resolver (ADR-0033, SUV-0058).
 *
 * Keep this out of browser-safe feature-flags.ts: it reads workspace config
 * from disk, and the persisted `defaults.pages.enabled` boolean is the sole
 * runtime authority. Missing or malformed config is always disabled.
 */
import { loadWorkspaceConfig } from '../workspaces/storage.ts';

export function isPagesEnabled(workspaceRootPath: string | undefined): boolean {
  if (!workspaceRootPath) return false;
  try {
    return loadWorkspaceConfig(workspaceRootPath)?.defaults?.pages?.enabled === true;
  } catch {
    return false;
  }
}

export function assertPagesEnabled(workspaceRootPath: string | undefined): void {
  if (!isPagesEnabled(workspaceRootPath)) {
    throw new Error('PAGES_DISABLED: Pages are unavailable until enabled for this workspace.');
  }
}
