import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceAtPath, loadWorkspaceConfig, saveWorkspaceConfig } from '../storage.ts'
import { isPagesEnabled } from '../../feature-flags.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pages-workspace-config-'))
  tempDirs.push(root)
  return root
}

describe('workspace Pages capability (SUV-0058)', () => {
  test('migrates an existing workspace with no Pages key to disabled', () => {
    const root = workspaceRoot()
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      id: 'ws_legacy', name: 'Legacy', slug: 'legacy', defaults: {}, createdAt: 1, updatedAt: 1,
    }))

    expect(loadWorkspaceConfig(root)?.defaults?.pages).toEqual({ enabled: false })
    expect(isPagesEnabled(root)).toBe(false)
  })

  test('persists Pages independently per workspace and defaults new workspaces off', () => {
    const first = workspaceRoot()
    const second = workspaceRoot()
    createWorkspaceAtPath(first, 'First')
    createWorkspaceAtPath(second, 'Second')

    expect(isPagesEnabled(first)).toBe(false)
    expect(isPagesEnabled(second)).toBe(false)

    const config = loadWorkspaceConfig(first)!
    config.defaults!.pages = { enabled: true }
    saveWorkspaceConfig(first, config)

    expect(isPagesEnabled(first)).toBe(true)
    expect(isPagesEnabled(second)).toBe(false)
    expect(JSON.parse(readFileSync(join(first, 'config.json'), 'utf8')).defaults.pages).toEqual({ enabled: true })
  })
})
