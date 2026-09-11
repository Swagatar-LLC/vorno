import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPageGrant, createPage, revokePageGrant, updatePage } from './storage.ts'
import { buildPageRefreshMatchers } from './refresh.ts'

describe('Page refresh availability gate', () => {
  test('does not materialize scheduled refreshes while Pages is disabled', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-refresh-gate-'))
    try {
      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        id: 'ws_refresh', name: 'Refresh', slug: 'refresh', defaults: { pages: { enabled: false } }, createdAt: 1, updatedAt: 1,
      }))
      const page = createPage(workspace, { name: 'Refresh me', content: '<p>ready</p>' })
      const grant = addPageGrant(workspace, page.slug, {
        action: { kind: 'script', script: 'scripts/refresh.ts' },
      })
      updatePage(workspace, page.slug, {
        refresh: { cron: '*/5 * * * *', script: 'scripts/refresh.ts', grantId: grant.id },
      })
      expect(buildPageRefreshMatchers(workspace)).toEqual([])

      writeFileSync(join(workspace, 'config.json'), JSON.stringify({
        id: 'ws_refresh', name: 'Refresh', slug: 'refresh', defaults: { pages: { enabled: true } }, createdAt: 1, updatedAt: 2,
      }))
      const [matcher] = buildPageRefreshMatchers(workspace)
      expect(matcher?.actions[0]).toMatchObject({ type: 'script', page: page.slug, grantId: grant.id })
      expect(revokePageGrant(workspace, page.slug, grant.id)).toBe(true)
      expect(buildPageRefreshMatchers(workspace)).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
