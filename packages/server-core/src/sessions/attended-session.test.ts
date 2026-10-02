import { describe, expect, it } from 'bun:test'
import { isAttendedSession } from './SessionManager.ts'

type Fields = { id: string; parentSessionId?: string; triggeredBy?: object; taskRunId?: string; taskSlug?: string; hidden?: boolean; unattended?: boolean; systemPromptPreset?: string }

const attended = (fields: Fields) => isAttendedSession(fields as never)

describe('isAttendedSession', () => {
  it('is true for an ordinary chat, and for subtasks under it', () => {
    expect(attended({ id: 'chat' })).toBe(true)
    expect(attended({ id: 'subtask', parentSessionId: 'chat' })).toBe(true)
  })

  it('is false for automation, task, hidden, mini and unattended sessions', () => {
    for (const fields of [
      { triggeredBy: { automationName: 'a' } }, { taskRunId: 'r' }, { taskSlug: 't' }, { hidden: true }, { unattended: true }, { systemPromptPreset: 'mini' },
    ]) {
      expect(attended({ id: 's', ...fields })).toBe(false)
    }
  })

  it('follows only its own flags: a subtask a user adds under an automation session is attended', () => {
    // Spawned children of unattended sessions get `unattended` at spawn time instead.
    expect(attended({ id: 'kanban-subtask', parentSessionId: 'automation' })).toBe(true)
  })
})
