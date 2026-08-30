/**
 * Filesystem store for the built-in markdown memory provider
 * (fork: PLAN-040 / SUV-0040).
 *
 * All the I/O the provider does lives here, so the provider itself is ranking
 * logic over an injectable store and the "does this thing touch the network"
 * question has exactly one file to read. It uses `node:fs` and nothing else —
 * no HTTP client, no subprocess, no dynamic import. That is what makes
 * SUV-0040's no-egress acceptance item assertable by test rather than by
 * review.
 *
 * ## Layout
 *
 * ```
 * <workspaceRoot>/memory/
 *   entries/*.md          hot — searched by default
 *   archive/*.md          cold storage — reachable only on purpose
 *   retrieval-log.jsonl   one line per gated retrieval
 * ```
 *
 * Plain directories of plain markdown, inside the workspace, browsable in
 * Finder and greppable from a shell. This is ADR-0027's file-first bias made
 * literal at the storage layer — the thing ADR-0029 had to relocate to the
 * *interface* because Headroom's substrate is SQLite. For the default provider
 * it is true again at the bytes.
 *
 * Every function here is failure-tolerant by contract: a missing directory, an
 * unreadable file, or a full disk degrades the operation and never throws.
 * Memory is an enrichment; it does not get to take down a session.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { debug } from '../utils/debug.ts';
import {
  memoryFileName,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFileEntry,
} from './memory-file.ts';

/** Resolved directory layout for one workspace's memory store. */
export interface MemoryStorePaths {
  readonly root: string;
  readonly entries: string;
  readonly archive: string;
  readonly retrievalLog: string;
}

export const MEMORY_DIR_NAME = 'memory';
export const MEMORY_ENTRIES_DIR = 'entries';
export const MEMORY_ARCHIVE_DIR = 'archive';
export const MEMORY_RETRIEVAL_LOG = 'retrieval-log.jsonl';

/** Where a workspace's memories live. Pure path arithmetic; creates nothing. */
export function resolveMemoryStorePaths(workspaceRootPath: string): MemoryStorePaths {
  const root = join(workspaceRootPath, MEMORY_DIR_NAME);
  return {
    root,
    entries: join(root, MEMORY_ENTRIES_DIR),
    archive: join(root, MEMORY_ARCHIVE_DIR),
    retrievalLog: join(root, MEMORY_RETRIEVAL_LOG),
  };
}

function ensureDir(path: string): boolean {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    return true;
  } catch (error) {
    debug('[memory] mkdir failed:', path, error);
    return false;
  }
}

/**
 * Create the store's directories.
 *
 * Called lazily on the first write rather than eagerly at provider
 * construction, so merely *selecting* this provider without enabling memory
 * does not scatter empty directories through a user's workspace.
 */
export function ensureMemoryStore(paths: MemoryStorePaths): boolean {
  return ensureDir(paths.entries) && ensureDir(paths.archive);
}

function readEntriesFrom(dir: string, archived: boolean): MemoryFileEntry[] {
  let names: string[];
  try {
    if (!existsSync(dir)) return [];
    names = readdirSync(dir);
  } catch (error) {
    debug('[memory] readdir failed:', dir, error);
    return [];
  }

  const out: MemoryFileEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    try {
      const parsed = parseMemoryFile(readFileSync(path, 'utf8'), path);
      if (!parsed) {
        debug('[memory] skipping unparseable memory file:', path);
        continue;
      }
      // The directory a file sits in is the authority on whether it is cold,
      // not its frontmatter. A hand-moved file with stale frontmatter would
      // otherwise be able to re-enter the hot path silently.
      if (archived && !parsed.archivedAt) {
        out.push({ ...parsed, archivedAt: parsed.updatedAt, archiveReason: 'archived' });
      } else if (!archived && parsed.archivedAt) {
        out.push({ ...parsed, archivedAt: undefined, archiveReason: undefined });
      } else {
        out.push(parsed);
      }
    } catch (error) {
      debug('[memory] read failed:', path, error);
    }
  }
  return out;
}

/** Read the hot set, and optionally cold storage alongside it. */
export function readMemoryEntries(
  paths: MemoryStorePaths,
  options: { includeArchived?: boolean } = {},
): MemoryFileEntry[] {
  const hot = readEntriesFrom(paths.entries, false);
  if (!options.includeArchived) return hot;
  return [...hot, ...readEntriesFrom(paths.archive, true)];
}

/** Write one memory into the hot set. Returns false on any failure. */
export function writeMemoryEntry(paths: MemoryStorePaths, entry: MemoryFileEntry): boolean {
  if (!ensureMemoryStore(paths)) return false;
  const path = join(paths.entries, memoryFileName(entry.id));
  try {
    writeFileSync(path, serializeMemoryFile(entry), 'utf8');
    return true;
  } catch (error) {
    debug('[memory] write failed:', path, error);
    return false;
  }
}

/**
 * Move one memory into cold storage, stamping the archive marker and banner.
 *
 * **Never deletes.** The file moves; it does not disappear. That is the whole
 * distinction between decay and forgetting, and SUV-0040's acceptance asserts
 * the marker is observable on disk precisely so the distinction stays checkable
 * rather than merely intended.
 */
export function archiveMemoryEntry(
  paths: MemoryStorePaths,
  entry: MemoryFileEntry,
  reason: string,
  nowIso: string,
): boolean {
  if (!ensureMemoryStore(paths)) return false;
  const from = entry.path ?? join(paths.entries, memoryFileName(entry.id));
  const to = join(paths.archive, memoryFileName(entry.id));
  const archived: MemoryFileEntry = {
    ...entry,
    archivedAt: nowIso,
    archiveReason: reason,
    path: to,
  };
  try {
    writeFileSync(to, serializeMemoryFile(archived), 'utf8');
  } catch (error) {
    debug('[memory] archive write failed:', to, error);
    return false;
  }
  try {
    if (from !== to && existsSync(from)) unlinkSync(from);
  } catch (error) {
    // The archived copy exists, so the memory is safe; the hot copy lingering
    // is a duplicate, not a loss. Report the failure and keep going.
    debug('[memory] archive unlink failed:', from, error);
  }
  return true;
}

/**
 * Bring a memory back out of cold storage.
 *
 * Exposed because "reachable on purpose" has to include being able to act on
 * what you found. Restoring strips the archive marker and banner — a restored
 * memory is a current memory again, and a re-verified fact should not carry a
 * banner saying nothing has verified it.
 */
export function restoreMemoryEntry(
  paths: MemoryStorePaths,
  entry: MemoryFileEntry,
  nowIso: string,
): boolean {
  if (!ensureMemoryStore(paths)) return false;
  const restored: MemoryFileEntry = {
    ...entry,
    archivedAt: undefined,
    archiveReason: undefined,
    updatedAt: nowIso,
    path: join(paths.entries, memoryFileName(entry.id)),
  };
  if (!writeMemoryEntry(paths, restored)) return false;
  const cold = entry.path ?? join(paths.archive, memoryFileName(entry.id));
  try {
    if (existsSync(cold) && cold !== restored.path) unlinkSync(cold);
  } catch (error) {
    debug('[memory] restore unlink failed:', cold, error);
  }
  return true;
}

/**
 * One line of the retrieval log.
 *
 * Carries the *query* and the ids of what was kept — never the **content** of
 * any memory. That is the line the format draws: enough to audit and to
 * reinforce, not enough to become a second copy of the corpus with none of its
 * archiving discipline.
 */
export interface RetrievalLogLine {
  readonly ts: string;
  readonly query: string;
  readonly provider: string;
  readonly target: {
    readonly scope: Record<string, string>;
    readonly destination: string;
  };
  readonly loaded: number;
  readonly trimmed: number;
  readonly kept: readonly string[];
}

/**
 * Append one line to the retrieval log.
 *
 * Every read is recorded. Two jobs, and the second is the less obvious one:
 *
 * 1. **Audit.** "What did memory put in front of the model, and when" is
 *    answerable from a file the user can read, without instrumenting the app.
 * 2. **Reinforcement.** `kept` is the citation signal that resets a memory's
 *    decay clock (see `decay.ts`). Memories that keep earning their tokens stay
 *    fresh; unused ones age out honestly.
 *
 * Records ids, counts and the query — never memory *content*. A log that
 * duplicates the corpus is a second copy of the corpus with none of its
 * archiving discipline.
 */
export function appendRetrievalLog(paths: MemoryStorePaths, line: RetrievalLogLine): boolean {
  if (!ensureDir(paths.root)) return false;
  try {
    appendFileSync(paths.retrievalLog, `${JSON.stringify(line)}\n`, 'utf8');
    return true;
  } catch (error) {
    debug('[memory] retrieval log append failed:', paths.retrievalLog, error);
    return false;
  }
}

/** Read the retrieval log back, newest last. Malformed lines are skipped. */
export function readRetrievalLog(paths: MemoryStorePaths): RetrievalLogLine[] {
  try {
    if (!existsSync(paths.retrievalLog)) return [];
    return readFileSync(paths.retrievalLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as RetrievalLogLine;
        } catch {
          return null;
        }
      })
      .filter((line): line is RetrievalLogLine => line !== null);
  } catch (error) {
    debug('[memory] retrieval log read failed:', paths.retrievalLog, error);
    return [];
  }
}

/**
 * Record that a set of memories was cited, bumping their citation counts and
 * resetting their decay clocks.
 *
 * Deliberately writes `last-cited` and *not* `updated`: being read is not being
 * edited, and collapsing the two would make "when did this memory last change"
 * unanswerable. Both feed the decay anchor, so the reinforcement lands either
 * way — but only one of them is a lie.
 */
export function recordCitations(
  paths: MemoryStorePaths,
  entries: readonly MemoryFileEntry[],
  nowIso: string,
): number {
  let updated = 0;
  for (const entry of entries) {
    // Cold storage does not get reinforced by being read. A deliberate archive
    // lookup should not quietly resurrect the memory it found.
    if (entry.archivedAt) continue;
    const next: MemoryFileEntry = {
      ...entry,
      citations: entry.citations + 1,
      lastCitedAt: nowIso,
    };
    if (writeMemoryEntry(paths, next)) updated += 1;
  }
  return updated;
}

/** Best-effort rename used by tests and migrations. Never throws. */
export function moveMemoryFile(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (error) {
    debug('[memory] move failed:', from, to, error);
    return false;
  }
}
