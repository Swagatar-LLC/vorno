#!/usr/bin/env bun
/**
 * Bump the workspace version cluster — the single place a Vorno release
 * version is set (LEARNING-025 / ADR-0010).
 *
 * Every user-visible version surface resolves to one of these package.json
 * files at build or run time:
 *   - apps/electron/package.json  → app.getVersion() (bundle version,
 *     electron-updater semver comparison, WebUI server handshake)
 *   - packages/shared/package.json → getAppVersion() (Settings About, update
 *     toasts, Sentry release, auth User-Agent, system-prompt version stamp)
 *   - apps/cli/package.json       → `--version` output
 * A partial bump ships a build that lies about its own version, so this
 * script sets ALL of them atomically. apps/server is excluded — it is the
 * fork-owned trigger server on its own 0.x line (ADR-0008).
 *
 * Usage: bun scripts/bump-version.ts 0.11.4
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('Usage: bun scripts/bump-version.ts <semver>  (e.g. 0.11.4)')
  process.exit(1)
}

const ROOT = join(import.meta.dir, '..')

const FILES = [
  'package.json',
  'apps/cli/package.json',
  'apps/electron/package.json',
  'apps/viewer/package.json',
  'apps/webui/package.json',
  'packages/core/package.json',
  'packages/messaging-gateway/package.json',
  'packages/messaging-whatsapp-worker/package.json',
  'packages/pi-agent-server/package.json',
  'packages/server-core/package.json',
  'packages/server/package.json',
  'packages/session-mcp-server/package.json',
  'packages/session-tools-core/package.json',
  'packages/shared/package.json',
  'packages/ui/package.json',
  // apps/server intentionally excluded — independent version line (ADR-0008)
]

let failures = 0
for (const rel of FILES) {
  const path = join(ROOT, rel)
  const src = readFileSync(path, 'utf-8')
  const out = src.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`)
  if (out === src && !src.includes(`"version": "${version}"`)) {
    console.error(`FAILED: no version field replaced in ${rel}`)
    failures++
    continue
  }
  writeFileSync(path, out)
  console.log(`${rel} → ${version}`)
}

if (failures > 0) process.exit(1)

// Verify the two files that feed user-visible surfaces agree.
const electron = JSON.parse(readFileSync(join(ROOT, 'apps/electron/package.json'), 'utf-8')).version
const shared = JSON.parse(readFileSync(join(ROOT, 'packages/shared/package.json'), 'utf-8')).version
if (electron !== version || shared !== version) {
  console.error(`Post-check failed: electron=${electron} shared=${shared} expected=${version}`)
  process.exit(1)
}
console.log(`\nAll versions set to ${version}. Next: update release-notes, PR, then tag v${version} after merge.`)
