import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPage } from './storage.ts'
import { buildPageRefreshMatchers } from './refresh.ts'

const savedPages = process.env.CRAFT_FEATURE_PAGES

afterEach(() => {
  if (savedPages === undefined) delete process.env.CRAFT_FEATURE_PAGES
  else process.env.CRAFT_FEATURE_PAGES = savedPages
})

describe('Page refresh availability gate', () => {
  test('does not materialize scheduled refreshes while Pages is disabled', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pages-refresh-gate-'))
    try {
      createPage(workspace, {
        name: 'Refresh me',
        refresh: { cron: '*/5 * * * *', script: 'scripts/refresh.ts' },
      })
      delete process.env.CRAFT_FEATURE_PAGES
      expect(buildPageRefreshMatchers(workspace)).toEqual([])

      process.env.CRAFT_FEATURE_PAGES = '1'
      expect(buildPageRefreshMatchers(workspace)).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
