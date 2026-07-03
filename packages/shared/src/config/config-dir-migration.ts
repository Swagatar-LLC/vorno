/**
 * Config-dir resolution + one-time migration for the VORNO fork (VOR-2).
 *
 * The fork owns its own config root (`~/.vorno-agent`) so it can never collide
 * with upstream Craft Agents' `~/.craft-agent` (LEARNING-002: both apps used to
 * fight over `~/.craft-agent/.server.lock` and each other's data).
 *
 * Resolution order:
 *   1. `CRAFT_CONFIG_DIR` env var — explicit override always wins (documented
 *      escape hatch; used by multi-instance dev and the daily-driver script,
 *      which deliberately shares `~/.craft-agent` with upstream in thin-client mode).
 *   2. `~/.vorno-agent` — the fork default. On first use, existing fork data is
 *      migrated (copied, never moved) from the legacy locations.
 *
 * Migration is a marker-file state machine (`.config-dir-migration.json` inside
 * the target dir):
 *   - no marker, target empty/missing  → migrate from the first legacy dir with
 *     data (`~/.craft-agent-swagatar` preferred — unambiguously fork-originated —
 *     else `~/.craft-agent`), or fresh-create when none exists
 *   - marker `in-progress`, owner dead → roll back (delete the partial copy —
 *     safe because migration only ever writes into a dir it created) and re-run
 *   - marker `in-progress`, owner alive → wait briefly, then fail rather than
 *     launch against a half-copied dir
 *   - marker `complete`                → no-op (idempotent)
 *   - no marker, target has data       → adopt as-is (user-managed dir), never clobber
 *
 * Sources are strictly read-only: files are copied and checksum-verified
 * (sha256 recorded in the marker as the backup manifest); the legacy dir is
 * byte-identical afterwards. `~/.claude/` (the Claude SDK native-resume store)
 * is never read, written, or re-keyed by this module — guarded explicitly.
 *
 * This module must stay dependency-free (node builtins only): it runs at
 * module-eval time of `paths.ts`, before any other shared code.
 */

import { createHash } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join, relative, resolve, sep } from 'path';

export const FORK_CONFIG_DIR_NAME = '.vorno-agent';
export const UPSTREAM_CONFIG_DIR_NAME = '.craft-agent';
export const LEGACY_FORK_CONFIG_DIR_NAME = '.craft-agent-swagatar';
export const MIGRATION_MARKER_FILENAME = '.config-dir-migration.json';

/** Top-level entries never copied from a legacy dir (stale locks, logs). */
const COPY_EXCLUDES_TOP_LEVEL = new Set(['.server.lock', 'logs', 'main.log', MIGRATION_MARKER_FILENAME]);
/** Names skipped at any depth. */
const COPY_EXCLUDES_ANYWHERE = new Set(['.DS_Store']);

export type ConfigDirSource = 'env-override' | 'fork-default';

export interface ManifestEntry {
  /** Path relative to the config root (posix-style separators). */
  path: string;
  size: number;
  sha256: string;
}

export type MigrationAction =
  | 'migrated' // copied legacy data into the fork dir this run
  | 'fresh' // no legacy data anywhere; created an empty fork dir
  | 'adopted-existing' // fork dir already had data but no marker; adopted without copying
  | 'already-done'; // marker says a previous run completed

export interface MigrationOutcome {
  action: MigrationAction;
  /** Legacy dir the data came from (null for fresh/adopted). */
  sourceDir: string | null;
  fileCount: number;
  /** True when a crashed in-progress migration was rolled back before this run. */
  recoveredFromCrash: boolean;
}

export interface ConfigDirResolution {
  dir: string;
  source: ConfigDirSource;
  /** Human-readable explanation for the startup log line. */
  reason: string;
  /** Present only when the fork-default path ran the migration state machine. */
  migration: MigrationOutcome | null;
}

interface MigrationMarker {
  version: 1;
  state: 'in-progress' | 'complete';
  action?: Exclude<MigrationAction, 'already-done'>;
  sourceDir: string | null;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  /** Backup manifest: every file copied from the legacy dir, with checksums. */
  manifest?: ManifestEntry[];
}

export interface EnsureConfigDirOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** How long to wait for a live concurrent migration before failing. */
  waitMs?: number;
}

/** Pure resolution — no filesystem access. */
export function resolveConfigDir(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
): { dir: string; source: ConfigDirSource } {
  const override = env.CRAFT_CONFIG_DIR;
  if (override && override.trim() !== '') {
    return { dir: override, source: 'env-override' };
  }
  return { dir: join(homeDir, FORK_CONFIG_DIR_NAME), source: 'fork-default' };
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

/**
 * Hard guard: the migration must never operate on the Claude SDK native-resume
 * store (`~/.claude`). Re-keying or moving it silently breaks session resume.
 */
function assertOutsideClaudeStore(path: string, homeDir: string, role: string): void {
  const claudeDir = join(homeDir, '.claude');
  if (isPathInside(path, claudeDir)) {
    throw new Error(
      `[config-dir] Refusing to use ${role} "${path}": it is inside ${claudeDir}, ` +
      `the Claude SDK native-resume store, which must never be migrated or re-keyed.`,
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hashFileSync(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function readMarker(markerPath: string): MigrationMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as MigrationMarker;
    if (parsed && (parsed.state === 'in-progress' || parsed.state === 'complete')) return parsed;
  } catch {
    /* corrupt marker — treated as crashed in-progress below */
  }
  return { version: 1, state: 'in-progress', sourceDir: null };
}

function writeMarker(dir: string, marker: MigrationMarker): void {
  const markerPath = join(dir, MIGRATION_MARKER_FILENAME);
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(marker, null, 2), 'utf-8');
  renameSync(tmpPath, markerPath);
}

/** Does this directory look like a Craft Agent config root with real data? */
function hasCraftData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'workspaces'));
}

function isExcluded(relPath: string, name: string): boolean {
  if (COPY_EXCLUDES_ANYWHERE.has(name)) return true;
  // Top-level excludes: relPath has no separator when the entry sits at the root.
  if (!relPath.includes('/') && COPY_EXCLUDES_TOP_LEVEL.has(name)) return true;
  return false;
}

/**
 * Recursively copy `sourceDir` into `targetDir`, hashing every file on both
 * sides and failing loudly on any mismatch. Returns the backup manifest.
 * The source is opened read-only; nothing under it is modified.
 */
function copyTreeVerified(sourceDir: string, targetDir: string): ManifestEntry[] {
  const manifest: ManifestEntry[] = [];

  const walk = (relDir: string): void => {
    const absSource = relDir === '' ? sourceDir : join(sourceDir, relDir);
    const absTarget = relDir === '' ? targetDir : join(targetDir, relDir);
    mkdirSync(absTarget, { recursive: true });

    for (const entry of readdirSync(absSource, { withFileTypes: true })) {
      const relPath = relDir === '' ? entry.name : `${relDir.split(sep).join('/')}/${entry.name}`;
      if (isExcluded(relPath, entry.name)) continue;
      const srcPath = join(absSource, entry.name);
      const dstPath = join(absTarget, entry.name);

      if (entry.isDirectory()) {
        walk(relDir === '' ? entry.name : join(relDir, entry.name));
      } else if (entry.isFile()) {
        const sourceHash = hashFileSync(srcPath);
        const size = statSync(srcPath).size;
        // Read+write instead of copyFileSync so the bytes we hash are the bytes
        // that existed when we started; then re-hash the copy to verify.
        writeFileSync(dstPath, readFileSync(srcPath));
        const targetHash = hashFileSync(dstPath);
        if (targetHash !== sourceHash) {
          throw new Error(`[config-dir] Copy verification failed for ${relPath}: source ${sourceHash} != copy ${targetHash}`);
        }
        manifest.push({ path: relPath, size, sha256: sourceHash });
      }
      // Symlinks / sockets / fifos are intentionally skipped: config roots are
      // plain file trees, and a dangling symlink must not abort the migration.
    }
  };

  walk('');
  return manifest;
}

function targetHasUserData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    name => name !== MIGRATION_MARKER_FILENAME && !name.startsWith(`${MIGRATION_MARKER_FILENAME}.tmp-`) && name !== '.DS_Store',
  );
}

/**
 * Resolve the config dir and, when the fork default is in use, run the
 * one-time migration state machine. Synchronous by design: it executes at
 * module-eval of `paths.ts`, before anything can touch the config dir.
 */
export function ensureConfigDirReady(options: EnsureConfigDirOptions = {}): ConfigDirResolution {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const waitMs = options.waitMs ?? 15_000;

  const { dir, source } = resolveConfigDir(env, homeDir);
  assertOutsideClaudeStore(dir, homeDir, 'config dir');

  if (source === 'env-override') {
    // Explicit override: trust it verbatim, exactly like upstream. No dir
    // creation, no migration — the operator owns this path.
    return { dir, source, reason: 'CRAFT_CONFIG_DIR environment override', migration: null };
  }

  const markerPath = join(dir, MIGRATION_MARKER_FILENAME);
  let recoveredFromCrash = false;
  const deadline = Date.now() + waitMs;

  // Marker state machine loop (revisited after waiting on a live migrator).
  for (;;) {
    const marker = readMarker(markerPath);

    if (marker?.state === 'complete') {
      return {
        dir,
        source,
        reason: marker.action === 'migrated' && marker.sourceDir
          ? `fork default (previously migrated from ${marker.sourceDir})`
          : 'fork default (previously initialized)',
        migration: {
          action: 'already-done',
          sourceDir: marker.sourceDir ?? null,
          fileCount: marker.manifest?.length ?? 0,
          recoveredFromCrash,
        },
      };
    }

    if (marker?.state === 'in-progress') {
      const ownerAlive = typeof marker.pid === 'number' && marker.pid !== process.pid && isProcessAlive(marker.pid);
      if (ownerAlive) {
        if (Date.now() >= deadline) {
          throw new Error(
            `[config-dir] Migration into ${dir} is in progress by PID ${marker.pid} and did not finish within ${waitMs}ms. ` +
            `Refusing to launch against a partially-migrated config dir.`,
          );
        }
        sleepSync(250);
        continue;
      }
      // Crashed mid-migration: the target dir contains only migration-written
      // files (nothing else can launch before the marker turns complete), so
      // rolling back == deleting the partial copy and starting over.
      if (resolve(dir) !== resolve(join(homeDir, FORK_CONFIG_DIR_NAME))) {
        throw new Error(`[config-dir] Refusing rollback: unexpected target ${dir}`);
      }
      rmSync(dir, { recursive: true, force: true });
      recoveredFromCrash = true;
      continue;
    }

    // No marker.
    if (targetHasUserData(dir)) {
      // Pre-existing user-managed dir (or one created before markers existed):
      // adopt it as-is; never overwrite with legacy data.
      writeMarker(dir, {
        version: 1,
        state: 'complete',
        action: 'adopted-existing',
        sourceDir: null,
        completedAt: new Date().toISOString(),
      });
      return {
        dir,
        source,
        reason: 'fork default (adopted existing directory)',
        migration: { action: 'adopted-existing', sourceDir: null, fileCount: 0, recoveredFromCrash },
      };
    }

    // Legacy fork data: the dedicated fork dev dir is unambiguous and wins;
    // otherwise data in upstream's dir (the LEARNING-002 hazard) is migrated.
    const legacyCandidates = [join(homeDir, LEGACY_FORK_CONFIG_DIR_NAME), join(homeDir, UPSTREAM_CONFIG_DIR_NAME)];
    const migrationSource = legacyCandidates.find(hasCraftData) ?? null;

    if (!migrationSource) {
      mkdirSync(dir, { recursive: true });
      writeMarker(dir, {
        version: 1,
        state: 'complete',
        action: 'fresh',
        sourceDir: null,
        completedAt: new Date().toISOString(),
      });
      return {
        dir,
        source,
        reason: 'fork default (fresh install, no legacy data found)',
        migration: { action: 'fresh', sourceDir: null, fileCount: 0, recoveredFromCrash },
      };
    }

    assertOutsideClaudeStore(migrationSource, homeDir, 'migration source');

    mkdirSync(dir, { recursive: true });
    writeMarker(dir, {
      version: 1,
      state: 'in-progress',
      sourceDir: migrationSource,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    const manifest = copyTreeVerified(migrationSource, dir);

    writeMarker(dir, {
      version: 1,
      state: 'complete',
      action: 'migrated',
      sourceDir: migrationSource,
      pid: process.pid,
      completedAt: new Date().toISOString(),
      manifest,
    });

    return {
      dir,
      source,
      reason: `fork default (one-time migration copied ${manifest.length} files from ${migrationSource}; original left untouched)`,
      migration: { action: 'migrated', sourceDir: migrationSource, fileCount: manifest.length, recoveredFromCrash },
    };
  }
}
