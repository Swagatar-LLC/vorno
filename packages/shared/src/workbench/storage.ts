/**
 * Review Workbench Storage (ADR-0014, PLAN-024)
 *
 * The reviews store lives beside the governance corpus, as plain agent-minable
 * JSON files (Read/Grep, no new tools):
 *
 *   {workspaceRoot}/reviews/<workbenchId>/workbench.json      WorkbenchInstanceV1
 *   {workspaceRoot}/reviews/<workbenchId>/threads/<id>.json   ReviewThreadV1
 *
 * All functions take an absolute `workspaceRoot` (the workspace folder path),
 * mirroring projects/sessions storage. Corrupt individual files are skipped and
 * warned about, never thrown — one bad file must not sink a list.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync } from '../utils/files.ts';
import { debug } from '../utils/debug.ts';
import type {
  ReviewThreadV1,
  WorkbenchInstanceV1,
} from '@craft-agent/core/types';

// ============================================================
// Path helpers
// ============================================================

/** {workspaceRoot}/reviews */
export function getReviewsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'reviews');
}

/** {workspaceRoot}/reviews/<workbenchId> */
export function getWorkbenchPath(workspaceRoot: string, workbenchId: string): string {
  return join(getReviewsPath(workspaceRoot), workbenchId);
}

/** {workspaceRoot}/reviews/<workbenchId>/workbench.json */
export function getWorkbenchInstancePath(workspaceRoot: string, workbenchId: string): string {
  return join(getWorkbenchPath(workspaceRoot, workbenchId), 'workbench.json');
}

/** {workspaceRoot}/reviews/<workbenchId>/threads */
export function getWorkbenchThreadsPath(workspaceRoot: string, workbenchId: string): string {
  return join(getWorkbenchPath(workspaceRoot, workbenchId), 'threads');
}

/** {workspaceRoot}/reviews/<workbenchId>/threads/<threadId>.json */
export function getThreadPath(
  workspaceRoot: string,
  workbenchId: string,
  threadId: string,
): string {
  return join(getWorkbenchThreadsPath(workspaceRoot, workbenchId), `${threadId}.json`);
}

// ============================================================
// Directory setup
// ============================================================

export function ensureReviewsDir(workspaceRoot: string): void {
  const dir = getReviewsPath(workspaceRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Ensure a workbench folder (+ its threads/ subdir) exists. */
export function ensureWorkbenchDir(workspaceRoot: string, workbenchId: string): void {
  const threadsDir = getWorkbenchThreadsPath(workspaceRoot, workbenchId);
  if (!existsSync(threadsDir)) mkdirSync(threadsDir, { recursive: true });
}

// ============================================================
// ID generation (mirrors projects/storage `proj_${uuid.slice(0,8)}`)
// ============================================================

export function generateWorkbenchId(): string {
  return `wb_${randomUUID().slice(0, 8)}`;
}

export function generateThreadId(): string {
  return `thread_${randomUUID().slice(0, 8)}`;
}

// ============================================================
// Instance operations
// ============================================================

/**
 * Load a single workbench instance. Returns null if missing or unparseable.
 */
export function loadWorkbenchInstance(
  workspaceRoot: string,
  workbenchId: string,
): WorkbenchInstanceV1 | null {
  const path = getWorkbenchInstancePath(workspaceRoot, workbenchId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkbenchInstanceV1;
  } catch (error) {
    debug('[workbench] Failed to read workbench.json:', workbenchId, error);
    return null;
  }
}

/**
 * List all workbench instances in a workspace. Corrupt/missing instance files
 * are skipped with a warning (never thrown).
 */
export function listWorkbenchInstances(workspaceRoot: string): WorkbenchInstanceV1[] {
  const reviewsDir = getReviewsPath(workspaceRoot);
  if (!existsSync(reviewsDir)) return [];

  const instances: WorkbenchInstanceV1[] = [];
  for (const entry of readdirSync(reviewsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const instance = loadWorkbenchInstance(workspaceRoot, entry.name);
    if (instance) instances.push(instance);
  }
  instances.sort((a, b) => b.updatedAt - a.updatedAt);
  return instances;
}

export interface CreateWorkbenchInput {
  title: string;
  corpusRoots?: string[];
  artifactUris?: string[];
  boundSessionId?: string;
}

/**
 * Create a new review workbench instance and persist workbench.json.
 */
export function createWorkbenchInstance(
  workspaceRoot: string,
  input: CreateWorkbenchInput,
): WorkbenchInstanceV1 {
  const now = Date.now();
  const instance: WorkbenchInstanceV1 = {
    schemaVersion: 1,
    id: generateWorkbenchId(),
    type: 'review',
    title: input.title,
    corpusRoots: input.corpusRoots ?? [],
    artifactUris: input.artifactUris ?? [],
    boundSessionId: input.boundSessionId,
    createdAt: now,
    updatedAt: now,
  };

  ensureWorkbenchDir(workspaceRoot, instance.id);
  saveWorkbenchInstance(workspaceRoot, instance);
  return instance;
}

/** Persist a workbench instance (pretty JSON, atomic write). */
export function saveWorkbenchInstance(
  workspaceRoot: string,
  instance: WorkbenchInstanceV1,
): void {
  ensureWorkbenchDir(workspaceRoot, instance.id);
  atomicWriteFileSync(
    getWorkbenchInstancePath(workspaceRoot, instance.id),
    JSON.stringify(instance, null, 2),
  );
}

/**
 * Apply an additive patch to a workbench instance (arrays replace wholesale).
 * Returns the updated instance, or null when the workbench does not exist.
 */
export function updateWorkbenchInstance(
  workspaceRoot: string,
  workbenchId: string,
  patch: Partial<
    Pick<WorkbenchInstanceV1, 'title' | 'corpusRoots' | 'artifactUris' | 'boundSessionId'>
  >,
): WorkbenchInstanceV1 | null {
  const existing = loadWorkbenchInstance(workspaceRoot, workbenchId);
  if (!existing) return null;

  const updated: WorkbenchInstanceV1 = {
    ...existing,
    ...patch,
    // Immutable identity/lineage fields.
    schemaVersion: 1,
    id: existing.id,
    type: existing.type,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  saveWorkbenchInstance(workspaceRoot, updated);
  return updated;
}

// ============================================================
// Thread operations
// ============================================================

/**
 * List review threads for a workbench, optionally filtered to one artifact.
 * Corrupt thread files are skipped with a warning (never thrown).
 */
export function listThreads(
  workspaceRoot: string,
  workbenchId: string,
  artifactUri?: string,
): ReviewThreadV1[] {
  const threadsDir = getWorkbenchThreadsPath(workspaceRoot, workbenchId);
  if (!existsSync(threadsDir)) return [];

  const threads: ReviewThreadV1[] = [];
  for (const entry of readdirSync(threadsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(threadsDir, entry.name);
    try {
      const thread = JSON.parse(readFileSync(path, 'utf-8')) as ReviewThreadV1;
      if (artifactUri && thread.artifactUri !== artifactUri) continue;
      threads.push(thread);
    } catch (error) {
      debug('[workbench] Skipping corrupt thread file:', path, error);
    }
  }
  threads.sort((a, b) => a.createdAt - b.createdAt);
  return threads;
}

/** Load a single thread by id. Returns null if missing or unparseable. */
export function loadThread(
  workspaceRoot: string,
  workbenchId: string,
  threadId: string,
): ReviewThreadV1 | null {
  const path = getThreadPath(workspaceRoot, workbenchId, threadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ReviewThreadV1;
  } catch (error) {
    debug('[workbench] Failed to read thread file:', path, error);
    return null;
  }
}

/** Whether a thread file already exists on disk. */
export function threadExists(
  workspaceRoot: string,
  workbenchId: string,
  threadId: string,
): boolean {
  return existsSync(getThreadPath(workspaceRoot, workbenchId, threadId));
}

/** Persist a thread (pretty JSON, atomic write). */
export function saveThread(workspaceRoot: string, thread: ReviewThreadV1): void {
  ensureWorkbenchDir(workspaceRoot, thread.workbenchId);
  atomicWriteFileSync(
    getThreadPath(workspaceRoot, thread.workbenchId, thread.id),
    JSON.stringify(thread, null, 2),
  );
}

/**
 * Add a new thread. Returns the persisted thread, or null when the id already
 * exists (caller maps that to a 'duplicate-id' failure).
 */
export function addThread(
  workspaceRoot: string,
  thread: ReviewThreadV1,
): ReviewThreadV1 | null {
  if (threadExists(workspaceRoot, thread.workbenchId, thread.id)) return null;
  const now = Date.now();
  const toWrite: ReviewThreadV1 = {
    ...thread,
    schemaVersion: 1,
    createdAt: thread.createdAt || now,
    updatedAt: now,
  };
  saveThread(workspaceRoot, toWrite);
  return toWrite;
}

/**
 * Apply a partial patch to an existing thread. Returns the updated thread, or
 * null when the thread does not exist.
 */
export function updateThread(
  workspaceRoot: string,
  workbenchId: string,
  threadId: string,
  patch: Partial<ReviewThreadV1>,
): ReviewThreadV1 | null {
  const existing = loadThread(workspaceRoot, workbenchId, threadId);
  if (!existing) return null;

  const updated: ReviewThreadV1 = {
    ...existing,
    ...patch,
    // Immutable identity/lineage fields.
    schemaVersion: 1,
    id: existing.id,
    workbenchId: existing.workbenchId,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  saveThread(workspaceRoot, updated);
  return updated;
}

/**
 * Remove a thread file. Returns false when the thread does not exist.
 */
export function removeThread(
  workspaceRoot: string,
  workbenchId: string,
  threadId: string,
): boolean {
  const path = getThreadPath(workspaceRoot, workbenchId, threadId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    debug('[workbench] Failed to remove thread file:', path, error);
    return false;
  }
}
