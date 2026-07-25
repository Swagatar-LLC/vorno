import type { AnnotationV1 } from '@craft-agent/core'

export interface ResolvedTextAnnotation {
  annotation: AnnotationV1
  range: { start: number; end: number }
  method: 'text-position' | 'text-quote'
}

export interface UnresolvedTextAnnotation {
  annotation: AnnotationV1
  reason: 'missing-selectors' | 'invalid-position' | 'quote-not-found'
}

export interface ResolveTextAnnotationResult {
  resolved: ResolvedTextAnnotation[]
  unresolved: UnresolvedTextAnnotation[]
}

interface NormalizedText {
  text: string
  map: number[]
}

/**
 * v1 normalization policy for quote fallback matching:
 * - collapse any whitespace run (spaces, tabs, newlines) into a single space
 * - preserve all non-whitespace characters as-is
 *
 * We keep a char-level map back to original indices so resolved ranges are
 * returned in original (un-normalized) coordinates.
 */
function normalizeWhitespaceWithMap(input: string): NormalizedText {
  const outChars: string[] = []
  const map: number[] = []
  let i = 0
  let inWhitespace = false

  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        outChars.push(' ')
        map.push(i)
        inWhitespace = true
      }
      i += 1
      continue
    }

    inWhitespace = false
    outChars.push(ch)
    map.push(i)
    i += 1
  }

  return { text: outChars.join(''), map }
}

/**
 * Last-resort match: the quote itself, ignoring the recorded neighbours.
 *
 * Prefix/suffix are 24-character windows captured at selection time. Any nested
 * block that mounts or unmounts text next to the selection (a file-backed doc
 * block resolving, a collapsible section toggling) rewrites those neighbours,
 * and the anchored passes above then fail even though the quoted text is still
 * present. Dropping the anchors recovers those cases; when the quote occurs more
 * than once we keep the occurrence nearest the recorded position so the choice
 * stays deterministic rather than "first wins".
 */
function findQuoteRangeIgnoringAnchors(
  fullText: string,
  exact: string,
  hintStart: number | null,
): { start: number; end: number } | null {
  const normalizedFull = normalizeWhitespaceWithMap(fullText)
  const normalizedExact = normalizeWhitespaceWithMap(exact).text.trim()
  if (!normalizedExact) return null

  const candidates: Array<{ start: number; end: number }> = []
  let index = normalizedFull.text.indexOf(normalizedExact)
  while (index !== -1) {
    const originalStart = normalizedFull.map[index]
    const originalLast = normalizedFull.map[index + normalizedExact.length - 1]
    if (originalStart != null && originalLast != null) {
      candidates.push({ start: originalStart, end: originalLast + 1 })
    }
    index = normalizedFull.text.indexOf(normalizedExact, index + 1)
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1 || hintStart == null) return candidates[0]!

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.start - hintStart) < Math.abs(best.start - hintStart) ? candidate : best
  )
}

function findQuoteRange(
  fullText: string,
  quote: Extract<AnnotationV1['target']['selectors'][number], { type: 'text-quote' }>,
  hintStart: number | null = null,
): { start: number; end: number } | null {
  if (!quote.exact) return null

  // First try exact matching without normalization (fast path).
  let searchIndex = fullText.indexOf(quote.exact)
  while (searchIndex !== -1) {
    const candidateStart = searchIndex
    const candidateEnd = candidateStart + quote.exact.length

    const prefixOk = !quote.prefix || fullText.slice(Math.max(0, candidateStart - quote.prefix.length), candidateStart) === quote.prefix
    const suffixOk = !quote.suffix || fullText.slice(candidateEnd, candidateEnd + quote.suffix.length) === quote.suffix

    if (prefixOk && suffixOk) {
      return { start: candidateStart, end: candidateEnd }
    }

    searchIndex = fullText.indexOf(quote.exact, searchIndex + 1)
  }

  // Fallback: normalized matching for minor whitespace drift.
  const normalizedFull = normalizeWhitespaceWithMap(fullText)
  const normalizedExact = normalizeWhitespaceWithMap(quote.exact).text
  const normalizedPrefix = quote.prefix ? normalizeWhitespaceWithMap(quote.prefix).text : undefined
  const normalizedSuffix = quote.suffix ? normalizeWhitespaceWithMap(quote.suffix).text : undefined

  if (!normalizedExact) return null

  let normalizedIndex = normalizedFull.text.indexOf(normalizedExact)
  while (normalizedIndex !== -1) {
    const normalizedEnd = normalizedIndex + normalizedExact.length

    const prefixOk = !normalizedPrefix ||
      normalizedFull.text.slice(Math.max(0, normalizedIndex - normalizedPrefix.length), normalizedIndex) === normalizedPrefix
    const suffixOk = !normalizedSuffix ||
      normalizedFull.text.slice(normalizedEnd, normalizedEnd + normalizedSuffix.length) === normalizedSuffix

    if (prefixOk && suffixOk) {
      const originalStart = normalizedFull.map[normalizedIndex]
      const endMapIndex = normalizedEnd - 1
      const originalLast = normalizedFull.map[endMapIndex]
      if (originalStart != null && originalLast != null) {
        return { start: originalStart, end: originalLast + 1 }
      }
    }

    normalizedIndex = normalizedFull.text.indexOf(normalizedExact, normalizedIndex + 1)
  }

  return findQuoteRangeIgnoringAnchors(fullText, quote.exact, hintStart)
}

function normalizeForCompare(input: string): string {
  return normalizeWhitespaceWithMap(input).text.trim()
}

/**
 * A stored text-position range is only trustworthy while the rendered text it
 * was measured against is unchanged. Nested markdown blocks break that
 * assumption: file-backed doc/datatable blocks mount their text after the
 * annotation was created, and collapsible sections add/remove text on toggle,
 * so the same offsets now cover different characters. Verify the range still
 * yields the quoted text before trusting it; otherwise fall back to quote
 * search, which re-finds the real range.
 */
function positionMatchesQuote(
  fullText: string,
  range: { start: number; end: number },
  quote: Extract<AnnotationV1['target']['selectors'][number], { type: 'text-quote' }> | undefined,
): boolean {
  if (!quote?.exact) return true
  return normalizeForCompare(fullText.slice(range.start, range.end)) === normalizeForCompare(quote.exact)
}

export function resolveTextAnnotations(
  fullText: string,
  annotations: AnnotationV1[] | undefined,
): ResolveTextAnnotationResult {
  if (!annotations?.length) {
    return { resolved: [], unresolved: [] }
  }

  const resolved: ResolvedTextAnnotation[] = []
  const unresolved: UnresolvedTextAnnotation[] = []

  for (const annotation of annotations) {
    const selectors = annotation.target?.selectors ?? []
    if (!selectors.length) {
      unresolved.push({ annotation, reason: 'missing-selectors' })
      continue
    }

    const position = selectors.find(s => s.type === 'text-position') as Extract<
      AnnotationV1['target']['selectors'][number],
      { type: 'text-position' }
    > | undefined

    const quote = selectors.find(s => s.type === 'text-quote') as Extract<
      AnnotationV1['target']['selectors'][number],
      { type: 'text-quote' }
    > | undefined

    if (
      position &&
      Number.isInteger(position.start) &&
      Number.isInteger(position.end) &&
      position.start >= 0 &&
      position.end > position.start &&
      position.end <= fullText.length &&
      positionMatchesQuote(fullText, { start: position.start, end: position.end }, quote)
    ) {
      resolved.push({
        annotation,
        range: { start: position.start, end: position.end },
        method: 'text-position',
      })
      continue
    }

    if (!quote?.exact) {
      unresolved.push({ annotation, reason: 'invalid-position' })
      continue
    }

    const range = findQuoteRange(
      fullText,
      quote,
      position && Number.isInteger(position.start) && position.start >= 0 ? position.start : null,
    )
    if (!range) {
      unresolved.push({ annotation, reason: 'quote-not-found' })
      continue
    }

    resolved.push({ annotation, range, method: 'text-quote' })
  }

  return { resolved, unresolved }
}
