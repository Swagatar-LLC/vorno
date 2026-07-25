import { describe, expect, it } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import { resolveTextAnnotations } from '../annotation-resolver'

/**
 * Anchor drift in long transcripts and nested-markdown messages.
 *
 * Annotation offsets are measured against the *rendered* text of a message
 * (annotation-core.getCanonicalText walks the DOM text nodes). Nested markdown
 * blocks make that text non-constant:
 *  - file-backed doc/datatable blocks mount their text after the message first
 *    renders (MarkdownDocBlock, MarkdownDatatableBlock),
 *  - collapsible sections add/remove text on toggle (CollapsibleSection),
 *  - tabbed doc previews swap one document's text for another's.
 *
 * When the text shifts, a stored text-position range no longer covers the
 * quoted text. Resolving by position alone silently highlights the wrong words
 * (or, when the text shrinks, drops the highlight entirely) — which reads to
 * the user as "my follow-up did not save" while the annotation is still live
 * and still pending in the composer.
 */

function makeAnnotation(selectors: AnnotationV1['target']['selectors'], id = 'ann-drift'): AnnotationV1 {
  return {
    id,
    schemaVersion: 1,
    createdAt: 1700000000000,
    intent: 'comment',
    body: [{ type: 'highlight' }, { type: 'note', text: 'follow up', format: 'plain' }],
    target: {
      source: { sessionId: 's1', messageId: 'm1' },
      selectors,
    },
  }
}

describe('anchor drift from nested markdown blocks', () => {
  it('re-finds the quote when a lazily-loaded block prepends text (offsets shift right)', () => {
    // Text as rendered when the user made the selection: the file-backed doc
    // block had not resolved yet, so its content was absent.
    const atSelection = 'Summary line.\n\nThe wording is fantastic.'
    const quote = 'The wording is fantastic.'
    const start = atSelection.indexOf(quote)

    const ann = makeAnnotation([
      { type: 'text-position', start, end: start + quote.length },
      { type: 'text-quote', exact: quote, prefix: 'Summary line. ', suffix: '' },
    ])

    // Same message after the nested doc block mounted its text above the quote.
    const afterLoad = 'Summary line.\n\nLoaded document body with plenty of text.\n\nThe wording is fantastic.'

    const result = resolveTextAnnotations(afterLoad, [ann])
    expect(result.unresolved).toHaveLength(0)
    expect(result.resolved).toHaveLength(1)
    // The stale position would have highlighted "Loaded document body with…".
    expect(result.resolved[0]?.method).toBe('text-quote')
    expect(afterLoad.slice(result.resolved[0]!.range.start, result.resolved[0]!.range.end)).toBe(quote)
  })

  it('re-finds the quote when a collapsible section collapses (offsets shift left)', () => {
    const expanded = 'Intro.\n\nDetails: alpha beta gamma delta.\n\nDecision: ship it.'
    const quote = 'Decision: ship it.'
    const start = expanded.indexOf(quote)

    const ann = makeAnnotation([
      { type: 'text-position', start, end: start + quote.length },
      { type: 'text-quote', exact: quote, prefix: '', suffix: '' },
    ])

    const collapsed = 'Intro.\n\nDetails\n\nDecision: ship it.'

    const result = resolveTextAnnotations(collapsed, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(collapsed.slice(result.resolved[0]!.range.start, result.resolved[0]!.range.end)).toBe(quote)
  })

  it('never trusts an in-range position that no longer covers the quote', () => {
    // Position stays inside the new text (so the old "end <= length" check
    // passed) but now points at completely different words.
    const rendered = 'Row 1 value\nRow 2 value\nThe wording is fantastic.'
    const quote = 'The wording is fantastic.'
    const ann = makeAnnotation([
      { type: 'text-position', start: 0, end: quote.length },
      { type: 'text-quote', exact: quote },
    ])

    const result = resolveTextAnnotations(rendered, [ann])
    expect(result.resolved).toHaveLength(1)
    const resolvedText = rendered.slice(result.resolved[0]!.range.start, result.resolved[0]!.range.end)
    expect(resolvedText).toBe(quote)
    expect(resolvedText).not.toBe(rendered.slice(0, quote.length))
  })

  it('tolerates whitespace-only drift (markdown re-wrapping) without falling back to a wrong range', () => {
    const rendered = 'The   wording\nis fantastic.'
    const ann = makeAnnotation([
      { type: 'text-position', start: 0, end: rendered.length },
      { type: 'text-quote', exact: 'The wording is fantastic.' },
    ])

    const result = resolveTextAnnotations(rendered, [ann])
    expect(result.resolved).toHaveLength(1)
    // Whitespace normalization means the original range is still correct.
    expect(result.resolved[0]?.method).toBe('text-position')
  })

  it('reports quote-not-found (rather than a wrong highlight) when a tab swap replaces the text', () => {
    const otherTab = 'Completely different document contents.'
    const ann = makeAnnotation([
      { type: 'text-position', start: 0, end: 10 },
      { type: 'text-quote', exact: 'The wording is fantastic.' },
    ])

    const result = resolveTextAnnotations(otherTab, [ann])
    expect(result.resolved).toHaveLength(0)
    expect(result.unresolved[0]?.reason).toBe('quote-not-found')
  })

  it('picks the occurrence nearest the recorded position when the quote repeats', () => {
    const quote = 'ship it'
    const rendered = `${quote} early on\n\nfiller filler filler filler\n\n${quote} later on`
    const secondStart = rendered.lastIndexOf(quote)

    const ann = makeAnnotation([
      // Stale-but-nearby position, and a prefix that no longer matches because
      // a nested block rewrote the neighbouring text.
      { type: 'text-position', start: secondStart + 3, end: secondStart + 3 + quote.length },
      { type: 'text-quote', exact: quote, prefix: 'vanished neighbour ', suffix: '' },
    ])

    const result = resolveTextAnnotations(rendered, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.range.start).toBe(secondStart)
  })

  it('still resolves position-only annotations (no quote selector to verify against)', () => {
    const rendered = 'alpha beta gamma'
    const ann = makeAnnotation([{ type: 'text-position', start: 6, end: 10 }])

    const result = resolveTextAnnotations(rendered, [ann])
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.method).toBe('text-position')
  })

  it('resolves many annotations independently in a long, block-heavy message', () => {
    const quotes = Array.from({ length: 12 }, (_, i) => `finding number ${i} matters`)
    const rendered = quotes.map((q, i) => `## Section ${i}\n\n${q}\n`).join('\n')

    const annotations = quotes.map((q, i) =>
      makeAnnotation(
        [
          // Deliberately stale positions (all pointing at the document head).
          { type: 'text-position', start: 0, end: q.length },
          { type: 'text-quote', exact: q },
        ],
        `ann-${i}`,
      ),
    )

    const result = resolveTextAnnotations(rendered, annotations)
    expect(result.unresolved).toHaveLength(0)
    for (const item of result.resolved) {
      const idx = Number(item.annotation.id.split('-')[1])
      expect(rendered.slice(item.range.start, item.range.end)).toBe(quotes[idx]!)
    }
  })
})
