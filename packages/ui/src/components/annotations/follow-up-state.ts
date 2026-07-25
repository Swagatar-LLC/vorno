import type { AnnotationV1 } from '@craft-agent/core'

export type AnnotationFollowUpState = 'none' | 'pending' | 'sent'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function normalizeFollowUpText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The text an annotation points at: its quote selector, else the slice named by
 * its position selector, else a placeholder.
 *
 * Lives here rather than in `chat/follow-up-helpers` (which re-exports it for
 * back-compat) so the renderer's pure follow-up module can reach it without
 * importing the React chat barrel. `chat/follow-up-helpers` is not an exported
 * subpath of this package.
 */
export function extractAnnotationSelectedText(annotation: AnnotationV1, messageContent: string): string {
  const quoteSelector = annotation.target.selectors.find(
    (selector): selector is Extract<AnnotationV1['target']['selectors'][number], { type: 'text-quote' }> => selector.type === 'text-quote'
  )
  const quoteText = quoteSelector?.exact?.trim() ?? ''
  if (quoteText.length > 0) return quoteText

  const positionSelector = annotation.target.selectors.find(
    (selector): selector is Extract<AnnotationV1['target']['selectors'][number], { type: 'text-position' }> => selector.type === 'text-position'
  )
  if (positionSelector) {
    const start = Math.max(0, Math.min(positionSelector.start, messageContent.length))
    const end = Math.max(start, Math.min(positionSelector.end, messageContent.length))
    const slice = messageContent.slice(start, end).trim()
    if (slice.length > 0) return slice
  }

  return 'Selected text'
}

export function getAnnotationNoteText(annotation: AnnotationV1): string {
  const noteBody = annotation.body.find((body): body is Extract<AnnotationV1['body'][number], { type: 'note' }> => body.type === 'note')
  const bodyText = noteBody?.text?.trim() ?? ''
  if (bodyText.length > 0) return bodyText

  const followUpMeta = asRecord(asRecord(annotation.meta)?.followUp)
  const metaText = typeof followUpMeta?.text === 'string' ? followUpMeta.text.trim() : ''
  return metaText
}

export function getAnnotationFollowUpState(annotation: AnnotationV1): AnnotationFollowUpState {
  const noteText = getAnnotationNoteText(annotation)
  if (!noteText) return 'none'

  const followUpMeta = asRecord(asRecord(annotation.meta)?.followUp)
  if (!followUpMeta) return 'pending'

  const sentAt = typeof followUpMeta.lastSentAt === 'number'
    ? followUpMeta.lastSentAt
    : (typeof followUpMeta.sentAt === 'number' ? followUpMeta.sentAt : null)

  const sentTextRaw = typeof followUpMeta.lastSentText === 'string'
    ? followUpMeta.lastSentText
    : (typeof followUpMeta.sentText === 'string' ? followUpMeta.sentText : '')

  const sentText = sentTextRaw.trim()
  return sentAt != null && sentText.length > 0 && sentText === noteText.trim()
    ? 'sent'
    : 'pending'
}

export function isAnnotationFollowUpSent(annotation: AnnotationV1): boolean {
  return getAnnotationFollowUpState(annotation) === 'sent'
}

export function formatAnnotationFollowUpTooltipText(annotation: AnnotationV1, maxLength = 180): string {
  const note = normalizeFollowUpText(getAnnotationNoteText(annotation))
  if (!note) return ''

  return note.length > maxLength
    ? `${note.slice(0, maxLength - 1).trimEnd()}…`
    : note
}
