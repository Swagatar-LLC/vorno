/**
 * Content hashing + git-HEAD detection for artifact versioning.
 *
 * Carried over from workbench/artifacts.ts (which keeps its own copy for its
 * frozen tests). Identity is location (the URI); version is the content hash —
 * ADR-0016 §1.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'fs';

/** SHA-256 hex of a file's bytes. */
export function computeContentHash(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 hex of an in-memory string (utf-8). */
export function hashString(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Best-effort git HEAD SHA for a file's directory. Fail-soft to undefined
 * (untracked, no git, timeout) — a missing gitSha is never an error.
 */
export function getGitSha(fileDir: string): Promise<string | undefined> {
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
