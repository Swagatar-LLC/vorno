/**
 * VOR-2: config-dir separation & one-time migration (kills LEARNING-002).
 *
 * Covers the acceptance criteria:
 *  - fresh-start: fork default dir created with no env var
 *  - migrate: legacy data copied (not moved) with marker + checksum manifest
 *  - idempotent re-run: second start is a no-op
 *  - upstream-untouched: legacy dir byte-identical after migration
 *  - override: CRAFT_CONFIG_DIR always wins, no migration
 *  - crash-mid-migration: marker state machine rolls back and re-runs
 *  - guard: ~/.claude/projects (Claude SDK native-resume store) never touched,
 *    and copied sessions still reference the same resume IDs
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  ensureConfigDirReady,
  FORK_CONFIG_DIR_NAME,
  LEGACY_FORK_CONFIG_DIR_NAME,
  MIGRATION_MARKER_FILENAME,
  resolveConfigDir,
  UPSTREAM_CONFIG_DIR_NAME,
} from '../config-dir-migration.ts'

const PATHS_MODULE_URL = pathToFileURL(join(import.meta.dir, '..', 'paths.ts')).href

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'vor2-home-'))
}

/** Populate a dir so it looks like a real Craft Agent config root. */
function seedCraftData(dir: string, tag: string): void {
  mkdirSync(join(dir, 'workspaces', 'my-workspace', 'sessions', 'sess-1'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ tag, workspaces: [] }))
  writeFileSync(join(dir, 'credentials.enc'), `encrypted-credentials-${tag}`)
  writeFileSync(
    join(dir, 'workspaces', 'my-workspace', 'sessions', 'sess-1', 'session.json'),
    JSON.stringify({ id: 'sess-1', claudeSessionId: `claude-resume-${tag}` }),
  )
  writeFileSync(join(dir, '.server.lock'), JSON.stringify({ pid: 12345, startedAt: 1 }))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(join(dir, 'logs', 'main.log'), 'old log lines')
}

/** relPath → sha256 for every file under dir. */
function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(relPath)
      else if (entry.isFile()) {
        out.set(relPath, createHash('sha256').update(readFileSync(join(dir, relPath))).digest('hex'))
      }
    }
  }
  walk('')
  return out
}

function readMarker(dir: string): any {
  return JSON.parse(readFileSync(join(dir, MIGRATION_MARKER_FILENAME), 'utf-8'))
}

describe('resolveConfigDir', () => {
  it('prefers CRAFT_CONFIG_DIR when set', () => {
    const { dir, source } = resolveConfigDir({ CRAFT_CONFIG_DIR: '/tmp/custom' }, '/home/u')
    expect(dir).toBe('/tmp/custom')
    expect(source).toBe('env-override')
  })

  it('falls back to the fork default with no env var', () => {
    const { dir, source } = resolveConfigDir({}, '/home/u')
    expect(dir).toBe(join('/home/u', FORK_CONFIG_DIR_NAME))
    expect(source).toBe('fork-default')
  })
})

describe('ensureConfigDirReady', () => {
  it('fresh machine: creates the fork dir with a complete marker and no migration source', () => {
    const home = makeHome()
    const res = ensureConfigDirReady({ env: {}, homeDir: home })

    expect(res.source).toBe('fork-default')
    expect(res.dir).toBe(join(home, FORK_CONFIG_DIR_NAME))
    expect(res.migration?.action).toBe('fresh')
    expect(existsSync(res.dir)).toBe(true)
    const marker = readMarker(res.dir)
    expect(marker.state).toBe('complete')
    expect(marker.action).toBe('fresh')
    expect(marker.sourceDir).toBeNull()
  })

  it('CRAFT_CONFIG_DIR override wins: no migration, no marker, dir untouched', () => {
    const home = makeHome()
    const override = join(home, 'elsewhere')
    // Legacy data exists, but the override must suppress migration entirely.
    seedCraftData(join(home, UPSTREAM_CONFIG_DIR_NAME), 'upstream')
    mkdirSync(join(home, UPSTREAM_CONFIG_DIR_NAME), { recursive: true })

    const res = ensureConfigDirReady({ env: { CRAFT_CONFIG_DIR: override }, homeDir: home })

    expect(res.dir).toBe(override)
    expect(res.source).toBe('env-override')
    expect(res.migration).toBeNull()
    expect(existsSync(join(home, FORK_CONFIG_DIR_NAME))).toBe(false)
    expect(existsSync(join(override, MIGRATION_MARKER_FILENAME))).toBe(false)
  })

  it('refuses a config dir inside ~/.claude (native-resume store guard)', () => {
    const home = makeHome()
    expect(() =>
      ensureConfigDirReady({ env: { CRAFT_CONFIG_DIR: join(home, '.claude', 'projects', 'x') }, homeDir: home }),
    ).toThrow(/native-resume store/)
  })

  it('migrates legacy upstream-dir data: copied with checksum manifest, locks/logs excluded', () => {
    const home = makeHome()
    const legacy = join(home, UPSTREAM_CONFIG_DIR_NAME)
    seedCraftData(legacy, 'fork-data')

    const res = ensureConfigDirReady({ env: {}, homeDir: home })
    const target = res.dir

    expect(res.migration?.action).toBe('migrated')
    expect(res.migration?.sourceDir).toBe(legacy)

    // Data intact: config, credentials, sessions
    expect(JSON.parse(readFileSync(join(target, 'config.json'), 'utf-8')).tag).toBe('fork-data')
    expect(readFileSync(join(target, 'credentials.enc'), 'utf-8')).toBe('encrypted-credentials-fork-data')
    expect(existsSync(join(target, 'workspaces', 'my-workspace', 'sessions', 'sess-1', 'session.json'))).toBe(true)

    // Stale lock and logs not carried over
    expect(existsSync(join(target, '.server.lock'))).toBe(false)
    expect(existsSync(join(target, 'logs'))).toBe(false)

    // Marker: complete, with a sha256 backup manifest matching the copies
    const marker = readMarker(target)
    expect(marker.state).toBe('complete')
    expect(marker.action).toBe('migrated')
    expect(marker.manifest.length).toBeGreaterThanOrEqual(3)
    const copied = hashTree(target)
    for (const entry of marker.manifest) {
      expect(copied.get(entry.path)).toBe(entry.sha256)
    }
  })

  it('prefers the dedicated legacy fork dir (~/.craft-agent-swagatar) over upstream\'s dir', () => {
    const home = makeHome()
    seedCraftData(join(home, LEGACY_FORK_CONFIG_DIR_NAME), 'swagatar')
    seedCraftData(join(home, UPSTREAM_CONFIG_DIR_NAME), 'upstream')

    const res = ensureConfigDirReady({ env: {}, homeDir: home })

    expect(res.migration?.sourceDir).toBe(join(home, LEGACY_FORK_CONFIG_DIR_NAME))
    expect(JSON.parse(readFileSync(join(res.dir, 'config.json'), 'utf-8')).tag).toBe('swagatar')
  })

  it('leaves the upstream dir byte-identical after migration (checksum-verified)', () => {
    const home = makeHome()
    const legacy = join(home, UPSTREAM_CONFIG_DIR_NAME)
    seedCraftData(legacy, 'upstream-data')
    const before = hashTree(legacy)

    ensureConfigDirReady({ env: {}, homeDir: home })

    const after = hashTree(legacy)
    expect(after.size).toBe(before.size)
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash)
    }
    // The lock file specifically must still be present in the source.
    expect(existsSync(join(legacy, '.server.lock'))).toBe(true)
  })

  it('is idempotent: a second run is a no-op and never re-copies', () => {
    const home = makeHome()
    const legacy = join(home, UPSTREAM_CONFIG_DIR_NAME)
    seedCraftData(legacy, 'v1')

    const first = ensureConfigDirReady({ env: {}, homeDir: home })
    expect(first.migration?.action).toBe('migrated')

    // Mutate the legacy source afterwards — a re-run must NOT pick this up.
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ tag: 'v2-post-migration' }))

    const second = ensureConfigDirReady({ env: {}, homeDir: home })
    expect(second.migration?.action).toBe('already-done')
    expect(JSON.parse(readFileSync(join(second.dir, 'config.json'), 'utf-8')).tag).toBe('v1')
  })

  it('adopts a pre-existing fork dir without clobbering it from legacy data', () => {
    const home = makeHome()
    const target = join(home, FORK_CONFIG_DIR_NAME)
    seedCraftData(target, 'already-mine')
    seedCraftData(join(home, UPSTREAM_CONFIG_DIR_NAME), 'upstream')

    const res = ensureConfigDirReady({ env: {}, homeDir: home })

    expect(res.migration?.action).toBe('adopted-existing')
    expect(JSON.parse(readFileSync(join(target, 'config.json'), 'utf-8')).tag).toBe('already-mine')
    expect(readMarker(target).action).toBe('adopted-existing')
  })

  it('crash mid-migration: dead-owner in-progress marker is rolled back and migration re-runs', () => {
    const home = makeHome()
    const legacy = join(home, UPSTREAM_CONFIG_DIR_NAME)
    seedCraftData(legacy, 'real-data')

    // Simulate a crashed previous run: partial copy + in-progress marker
    // owned by a PID that no longer exists.
    const target = join(home, FORK_CONFIG_DIR_NAME)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'config.json'), '{"tag":"PARTIAL-GARBAGE"')
    writeFileSync(
      join(target, MIGRATION_MARKER_FILENAME),
      JSON.stringify({ version: 1, state: 'in-progress', sourceDir: legacy, pid: 999_999_9 }),
    )

    const res = ensureConfigDirReady({ env: {}, homeDir: home })

    expect(res.migration?.action).toBe('migrated')
    expect(res.migration?.recoveredFromCrash).toBe(true)
    expect(JSON.parse(readFileSync(join(target, 'config.json'), 'utf-8')).tag).toBe('real-data')
    expect(readMarker(target).state).toBe('complete')
  })

  it('corrupt marker is treated as a crashed migration and recovered', () => {
    const home = makeHome()
    seedCraftData(join(home, UPSTREAM_CONFIG_DIR_NAME), 'good')
    const target = join(home, FORK_CONFIG_DIR_NAME)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, MIGRATION_MARKER_FILENAME), 'not json at all')

    const res = ensureConfigDirReady({ env: {}, homeDir: home })
    expect(res.migration?.action).toBe('migrated')
    expect(res.migration?.recoveredFromCrash).toBe(true)
  })

  it('live concurrent migration: waits, then refuses to launch against a half-copied dir', async () => {
    const home = makeHome()
    seedCraftData(join(home, UPSTREAM_CONFIG_DIR_NAME), 'x')
    const target = join(home, FORK_CONFIG_DIR_NAME)
    mkdirSync(target, { recursive: true })

    // A genuinely live foreign process holds the marker.
    const holder = Bun.spawn(['sleep', '30'])
    try {
      writeFileSync(
        join(target, MIGRATION_MARKER_FILENAME),
        JSON.stringify({ version: 1, state: 'in-progress', sourceDir: null, pid: holder.pid }),
      )
      expect(() => ensureConfigDirReady({ env: {}, homeDir: home, waitMs: 600 })).toThrow(/in progress by PID/)
    } finally {
      holder.kill()
      await holder.exited
    }
  })

  it('never touches ~/.claude/projects and preserves session resume IDs (post-migration resume)', () => {
    const home = makeHome()
    const legacy = join(home, UPSTREAM_CONFIG_DIR_NAME)
    seedCraftData(legacy, 'resume-me')

    // Claude SDK native-resume store: transcript keyed by claudeSessionId.
    const claudeProjects = join(home, '.claude', 'projects', '-Users-x-proj')
    mkdirSync(claudeProjects, { recursive: true })
    writeFileSync(join(claudeProjects, 'claude-resume-resume-me.jsonl'), '{"type":"turn"}\n')
    const claudeBefore = hashTree(join(home, '.claude'))

    const res = ensureConfigDirReady({ env: {}, homeDir: home })

    // Resume store byte-identical — nothing moved, nothing re-keyed.
    const claudeAfter = hashTree(join(home, '.claude'))
    expect(claudeAfter.size).toBe(claudeBefore.size)
    for (const [path, hash] of claudeBefore) {
      expect(claudeAfter.get(path)).toBe(hash)
    }

    // The migrated session still references the same claudeSessionId, and the
    // transcript it points to still exists at its original path → resume works.
    const session = JSON.parse(
      readFileSync(join(res.dir, 'workspaces', 'my-workspace', 'sessions', 'sess-1', 'session.json'), 'utf-8'),
    )
    expect(session.claudeSessionId).toBe('claude-resume-resume-me')
    expect(existsSync(join(claudeProjects, `${session.claudeSessionId}.jsonl`))).toBe(true)
  })
})

describe('paths.ts wiring (subprocess integration)', () => {
  function runPathsSubprocess(env: Record<string, string | undefined>): { configDir: string; source: string } {
    const run = Bun.spawnSync(
      [process.execPath, '--eval', `
        const { CONFIG_DIR, CONFIG_DIR_RESOLUTION } = await import('${PATHS_MODULE_URL}');
        console.log(JSON.stringify({ configDir: CONFIG_DIR, source: CONFIG_DIR_RESOLUTION.source }));
      `],
      { env: { PATH: process.env.PATH, ...env }, stdout: 'pipe', stderr: 'pipe' },
    )
    if (run.exitCode !== 0) {
      throw new Error(`paths.ts subprocess failed:\n${run.stderr.toString()}`)
    }
    const lines = run.stdout.toString().trim().split('\n')
    return JSON.parse(lines[lines.length - 1]!)
  }

  it('defaults to ~/.vorno-agent (fork default) with no env var', () => {
    const home = makeHome()
    const result = runPathsSubprocess({ HOME: home, USERPROFILE: home })
    expect(result.configDir).toBe(join(home, FORK_CONFIG_DIR_NAME))
    expect(result.source).toBe('fork-default')
    expect(existsSync(join(home, FORK_CONFIG_DIR_NAME, MIGRATION_MARKER_FILENAME))).toBe(true)
  })

  it('honors CRAFT_CONFIG_DIR (escape hatch)', () => {
    const home = makeHome()
    const override = join(home, 'my-own-dir')
    const result = runPathsSubprocess({ HOME: home, USERPROFILE: home, CRAFT_CONFIG_DIR: override })
    expect(result.configDir).toBe(override)
    expect(result.source).toBe('env-override')
  })

  it('migrates on first import when legacy fork data exists', () => {
    const home = makeHome()
    seedCraftData(join(home, LEGACY_FORK_CONFIG_DIR_NAME), 'via-paths')
    const result = runPathsSubprocess({ HOME: home, USERPROFILE: home })
    expect(result.configDir).toBe(join(home, FORK_CONFIG_DIR_NAME))
    expect(JSON.parse(readFileSync(join(home, FORK_CONFIG_DIR_NAME, 'config.json'), 'utf-8')).tag).toBe('via-paths')
  })
})
