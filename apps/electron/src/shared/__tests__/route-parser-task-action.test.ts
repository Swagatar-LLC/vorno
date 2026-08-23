import { describe, expect, it } from 'bun:test'
import { parseRoute } from '../route-parser'
import { routes } from '../routes'

describe('new-task action route', () => {
  it('round-trips the TaskEditor handoff fields', () => {
    const route = routes.action.newTask({
      title: 'PLAN-043 breakdown',
      goal: 'Build a small DAG with an adversarial verification node.',
      cwd: '/tmp/vorno repo',
      project: 'proj_123',
      author: 'generate',
    })

    expect(parseRoute(route)).toEqual({
      type: 'action',
      name: 'new-task',
      id: undefined,
      params: {
        title: 'PLAN-043 breakdown',
        goal: 'Build a small DAG with an adversarial verification node.',
        cwd: '/tmp/vorno repo',
        project: 'proj_123',
        author: 'generate',
      },
    })
  })
})
