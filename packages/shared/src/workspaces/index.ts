/**
 * Workspace Module
 *
 * Re-exports types and storage functions for workspaces.
 */

// Types
export type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

// Headroom config resolution (fork: PLAN-040, SUV-0016) and the editing view
// the workspace settings UI reads (SUV-0017)
export { loadEffectiveHeadroomConfig, loadHeadroomConfigView } from './headroom.ts';
export type { HeadroomConfigView } from './headroom.ts';

// Memory config resolution and its editing view (fork: PLAN-040, SUV-0029;
// ADR-0031). A sibling of the Headroom section above, not part of it.
export { loadEffectiveMemoryConfig, loadMemoryConfigView } from './memory.ts';
export type { MemoryConfigView } from './memory.ts';

// Storage functions
export {
  // Path utilities
  getDefaultWorkspacesDir,
  ensureDefaultWorkspacesDir,
  getWorkspacePath,
  getWorkspaceSourcesPath,
  getWorkspaceSessionsPath,
  getWorkspaceSkillsPath,
  // Config operations
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  // Load operations
  loadWorkspace,
  getWorkspaceSummary,
  // Create/Delete operations
  generateSlug,
  generateUniqueWorkspacePath,
  createWorkspaceAtPath,
  deleteWorkspaceFolder,
  isValidWorkspace,
  renameWorkspaceFolder,
  // Auto-discovery
  discoverWorkspacesInDefaultLocation,
  // Constants
  CONFIG_DIR,
  DEFAULT_WORKSPACES_DIR,
} from './storage.ts';
