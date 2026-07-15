/**
 * PLAN-021: `project/{projectId}` is a first-class sessions-navigator filter
 * route — the singular prefix, distinct from the plural `projects` navigator
 * (project list/detail pages). These mirror the label-filter route tests.
 */
import { describe, it, expect } from 'bun:test'
import {
  parseCompoundRoute,
  buildCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import { routes } from '../routes'
import { isSessionsNavigation } from '../types'

describe('route-parser: project filter routes', () => {
  it('parses a plain project route', () => {
    const result = parseCompoundRoute('project/proj_8e5b523d')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('sessions')
    expect(result!.sessionFilter).toEqual({ kind: 'project', projectId: 'proj_8e5b523d' })
    expect(result!.details).toBeNull()
  })

  it('round-trips a project route with session details', () => {
    const route = routes.view.projectSessions('proj_8e5b523d', 'abc123')
    expect(route).toBe('project/proj_8e5b523d/session/abc123')
    const state = parseRouteToNavigationState(route)
    if (!state || !isSessionsNavigation(state)) throw new Error('expected sessions navigation state')
    expect(state.filter).toEqual({ kind: 'project', projectId: 'proj_8e5b523d' })
    expect(state.details).toEqual({ type: 'session', sessionId: 'abc123' })
    expect(buildRouteFromNavigationState(state)).toBe('project/proj_8e5b523d/session/abc123')
  })

  it('builds project routes without details', () => {
    expect(
      buildCompoundRoute({
        navigator: 'sessions',
        sessionFilter: { kind: 'project', projectId: 'proj_8e5b523d' },
        details: null,
      })
    ).toBe('project/proj_8e5b523d')
  })

  it('the plural `projects` navigator is unaffected by the singular filter prefix', () => {
    const list = parseCompoundRoute('projects')
    expect(list).toEqual({ navigator: 'projects', details: null })
    const detail = parseCompoundRoute('projects/project/vorno')
    expect(detail).toEqual({ navigator: 'projects', details: { type: 'project', id: 'vorno' } })
  })

  it('a stray query tail never leaks into the parsed projectId (slash-segment invariant)', () => {
    const result = parseCompoundRoute('project/proj_8e5b523d?stray=x')
    expect(result).not.toBeNull()
    expect(result!.sessionFilter).toEqual({ kind: 'project', projectId: 'proj_8e5b523d' })
  })

  it('bare `project` with no id is not a valid route', () => {
    expect(parseCompoundRoute('project')).toBeNull()
  })
})
