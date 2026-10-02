/**
 * Auto-Label Rule Validation
 *
 * Validates auto-label rule patterns at config-save time to catch
 * invalid regex syntax and catastrophic backtracking patterns early.
 *
 * Called from the label config validator (validators.ts) when labels/config.json
 * is being written.
 */

export interface AutoLabelValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Known catastrophic backtracking patterns (nested quantifiers).
 * These can cause ReDoS (Regular Expression Denial of Service) by making
 * the regex engine take exponential time on non-matching inputs.
 *
 * Matches patterns like: (a+)+, (a*)+, (\w+)*, ([a-z]+)+
 */
const CATASTROPHIC_BACKTRACKING_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // (x+)+ or (x*)+ or (x+)* etc.
  /\([^)]*[+*][^)]*\)\{/,   // (x+){n} quantified groups with inner quantifier
]

/**
 * Validate a single auto-label rule.
 * Checks regex syntax, flags, and known problematic patterns.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional flags (defaults to 'gi')
 * @returns Validation result with errors/warnings
 */
export function validateAutoLabelRule(pattern: string, flags?: string): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Check regex compiles without errors
  try {
    const effectiveFlags = flags
      ? (flags.includes('g') ? flags : flags + 'g')
      : 'gi'
    new RegExp(pattern, effectiveFlags)
  } catch (e) {
    errors.push(`Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`)
    return { valid: false, errors, warnings }
  }

  // 2. Check for catastrophic backtracking patterns (nested quantifiers)
  for (const badPattern of CATASTROPHIC_BACKTRACKING_PATTERNS) {
    if (badPattern.test(pattern)) {
      errors.push(
        `Pattern contains nested quantifiers which can cause catastrophic backtracking (ReDoS). ` +
        `Simplify the pattern to avoid nested repetition like (a+)+.`
      )
      break
    }
  }

  // 3. Warn about missing capture groups when no valueTemplate could use $1
  if (!pattern.includes('(') || pattern.replace(/\(\?[:<!=]/g, '').indexOf('(') === -1) {
    warnings.push(
      'Pattern has no capture groups. The entire match will be used as the label value. ' +
      'Add capture groups (parentheses) to extract specific parts.'
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/** Longest question a semantic rule may ask (the message itself is the state; the question is instructions). */
export const SEMANTIC_RULE_MAX_QUESTION_CHARS = 500

/**
 * Validate a semantic (decision-model) auto-label rule: a non-empty question,
 * a threshold in (0, 1] when given, and a string value when given.
 */
export function validateSemanticAutoLabelRule(rule: { semantic?: unknown; threshold?: unknown; value?: unknown }): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof rule.semantic !== 'string' || !rule.semantic.trim()) {
    errors.push('Semantic rule needs a non-empty "semantic" question, e.g. "Is the user asking about billing?"')
  } else if (rule.semantic.length > SEMANTIC_RULE_MAX_QUESTION_CHARS) {
    errors.push(`Semantic question is too long (${rule.semantic.length} > ${SEMANTIC_RULE_MAX_QUESTION_CHARS} characters)`)
  } else if (!/\?\s*$/.test(rule.semantic.trim()) && !/^(is|are|does|do|did|has|have|was|were|should|can|could|will|would)\b/i.test(rule.semantic.trim())) {
    warnings.push('Semantic rules work best as a yes/no question ("Is the user asking about billing?")')
  }

  if (rule.threshold !== undefined) {
    if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold) || rule.threshold <= 0 || rule.threshold > 1) {
      errors.push('Semantic rule threshold must be a number greater than 0 and at most 1 (default 0.9)')
    } else if (rule.threshold < 0.5) {
      warnings.push('A threshold below 0.5 applies the label when the model leans "no" — probably not intended')
    }
  }

  if (rule.value !== undefined && typeof rule.value !== 'string') {
    errors.push('Semantic rule value must be a string')
  }

  return { valid: errors.length === 0, errors, warnings }
}
