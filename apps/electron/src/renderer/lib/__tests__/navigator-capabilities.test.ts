import { describe, expect, it } from 'bun:test'
import { isNavigatorAvailable } from '../navigator-capabilities'

describe('navigator capabilities', () => {
  it('hides only Pages when its workspace capability is disabled', () => {
    const capabilities = {
      pagesEnabled: false,
      workbenchEnabled: true,
      artifactsEnabled: true,
    }

    expect(isNavigatorAvailable('projects', capabilities)).toBe(true)
    expect(isNavigatorAvailable('pages', capabilities)).toBe(false)
    expect(isNavigatorAvailable('workbench', capabilities)).toBe(true)
    expect(isNavigatorAvailable('artifacts', capabilities)).toBe(true)
  })

  it('includes Pages alongside the existing navigators when enabled', () => {
    const capabilities = {
      pagesEnabled: true,
      workbenchEnabled: true,
      artifactsEnabled: true,
    }

    expect(['projects', 'pages', 'workbench', 'artifacts']
      .filter((navigator) => isNavigatorAvailable(navigator as 'projects' | 'pages' | 'workbench' | 'artifacts', capabilities)))
      .toEqual(['projects', 'pages', 'workbench', 'artifacts'])
  })
})
