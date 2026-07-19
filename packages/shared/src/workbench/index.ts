/**
 * Review Workbench module (ADR-0014, PLAN-024)
 *
 * Public exports for the workspace review store + on-demand artifact index.
 */

export {
  // Path helpers
  getReviewsPath,
  getWorkbenchPath,
  getWorkbenchInstancePath,
  getWorkbenchThreadsPath,
  getThreadPath,
  ensureReviewsDir,
  ensureWorkbenchDir,
  // ID generation
  generateWorkbenchId,
  generateThreadId,
  // Instance operations
  loadWorkbenchInstance,
  listWorkbenchInstances,
  createWorkbenchInstance,
  saveWorkbenchInstance,
  updateWorkbenchInstance,
  // Thread operations
  listThreads,
  loadThread,
  threadExists,
  saveThread,
  addThread,
  updateThread,
  removeThread,
} from './storage.ts';

export type { CreateWorkbenchInput } from './storage.ts';

export {
  indexArtifacts,
  readArtifact,
  resolveContainedArtifact,
  computeContentHash,
} from './artifacts.ts';

export type { ReadArtifactResult } from './artifacts.ts';
