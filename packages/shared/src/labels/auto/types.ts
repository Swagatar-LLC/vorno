/**
 * Auto-Label Types
 *
 * Result types for the auto-label evaluation pipeline.
 * An AutoLabelMatch represents a single extracted label+value from a user message.
 */

/**
 * A single match from auto-label evaluation.
 * Represents a label that should be applied to the session.
 */
export interface AutoLabelMatch {
  /** Label ID to apply */
  labelId: string
  /** Normalized value ready for storage (already formatted per valueType); empty for plain labels */
  value: string
  /** The original text in the message that triggered this match (regex), or the question asked (semantic) */
  matchedText: string
  /** Which rule kind produced the match */
  via?: 'regex' | 'semantic'
  /** Semantic rules only: the "yes" probability the decision model returned */
  probability?: number
}
