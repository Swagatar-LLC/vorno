import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPage } from './storage.ts'
import { buildPageRefreshMatchers } from './refresh.ts'

describe('Page refresh availability gate', () => {
  test('does not materialize scheduled refreshes while Pages is disabled', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-refresh-gate-'))
    try {
      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        id: 'ws_refresh', name: 'Refresh', slug: 'refresh', defaults: { pages: { enabled: false } }, createdAt: 1, updatedAt: 1,
      }))
      createPage(workspace, {
        name: 'Refresh me',
        refresh: { cron: '*/5 * * * *', script: 'scripts/refresh.ts' },
      })
      expect(buildPageRefreshMatchers(workspace)).toEqual([])

      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        id: 'ws_refresh', name: 'Refresh', slug: 'refresh', defaults: { pages: { enabled: true } }, createdAt: 1, updatedAt: 2,
      }))
      expect(buildPageRefreshMatchers(workspace)).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
