/**
 * Auto-Label Evaluator
 *
 * Core evaluation engine for auto-label rules. Two rule kinds live side by side
 * on `label.autoRules`:
 *
 * - Regex rules (`pattern`) run synchronously on every user message.
 * - Semantic rules (`semantic`) are yes/no questions for the decision model
 *   (Jev). They run asynchronously, off the turn's critical path, and only when
 *   the caller hands in a `decide` function — i.e. when the user enabled the
 *   decision layer. Without it they are inert.
 *
 * Regex flow:
 * 1. Strip code blocks from message (avoid matching inside code)
 * 2. Walk the label tree, collect all labels with autoRules
 * 3. For each rule: run regex with forced 'g' flag, substitute capture groups
 * 4. Normalize extracted values based on the label's valueType
 * 5. Deduplicate matches (same labelId + value = keep only first)
 * 6. Cap at MAX_MATCHES_PER_MESSAGE to prevent label explosion
 * 7. Return array of AutoLabelMatch ready for session storage
 *
 * Semantic flow: one `noul` question per rule (batched per call), apply the
 * label when the "yes" probability reaches the rule's threshold (default 0.9).
 */

import type { LabelConfig, AutoLabelRule, RegexAutoLabelRule, SemanticAutoLabelRule } from '../types.ts'
import { isRegexAutoLabelRule, isSemanticAutoLabelRule, DEFAULT_SEMANTIC_RULE_THRESHOLD } from '../types.ts'
import type { DecisionRequest, DecisionResult, NoulQuestion } from '../../decisions/types.ts'
import type { AutoLabelMatch } from './types.ts'
import { normalizeValue } from './normalize.ts'

/** Maximum number of auto-label matches per message to prevent label explosion from pasted logs/data */
const MAX_MATCHES_PER_MESSAGE = 10
/** Semantic rules see at most this much of the (code-stripped) message. */
export const SEMANTIC_RULE_MAX_MESSAGE_CHARS = 8_000
/** Messages shorter than this ("ok", "thanks") are not worth a decision call. */
export const SEMANTIC_RULE_MIN_MESSAGE_CHARS = 20
/** Semantic questions per decision call (the API documents no maximum; keep requests small). */
const SEMANTIC_RULES_PER_CALL = 20

/**
 * Recursively collect all labels that have autoRules defined (both kinds).
 * Walks the entire label tree depth-first.
 */
export function collectAutoLabelRules(labels: LabelConfig[]): Array<{
  label: LabelConfig
  rule: AutoLabelRule
}> {
  const result: Array<{ label: LabelConfig; rule: AutoLabelRule }> = []

  function walk(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules) {
        for (const rule of label.autoRules) {
          result.push({ label, rule })
        }
      }
      if (label.children) {
        walk(label.children)
      }
    }
  }

  walk(labels)
  return result
}

/** Only the semantic (decision-model) rules of the tree. */
export function collectSemanticAutoLabelRules(labels: LabelConfig[]): Array<{ label: LabelConfig; rule: SemanticAutoLabelRule }> {
  const out: Array<{ label: LabelConfig; rule: SemanticAutoLabelRule }> = []
  for (const entry of collectAutoLabelRules(labels)) {
    if (isSemanticAutoLabelRule(entry.rule)) out.push({ label: entry.label, rule: entry.rule })
  }
  return out
}

/**
 * Strip fenced code blocks and inline code from message text.
 * Prevents regex patterns from matching inside code examples, logs, etc.
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')  // fenced code blocks
    .replace(/`[^`]+`/g, '')          // inline code
}

/**
 * Session label entry for a match. Regex matches keep the historical `id::value`
 * form even for an empty value (existing sessions and filters rely on it);
 * semantic matches without a `value` apply the plain label id.
 */
/** Session label entry a semantic rule would apply (see autoLabelMatchToEntry). */
export function semanticRuleEntry(label: LabelConfig, rule: SemanticAutoLabelRule): string {
  const value = rule.value ? normalizeValue(rule.value, label.valueType) : ''
  return value ? `${label.id}::${value}` : label.id
}

export function autoLabelMatchToEntry(match: AutoLabelMatch): string {
  if (match.via === 'semantic' && !match.value) return match.labelId
  return `${match.labelId}::${match.value}`
}

/**
 * Evaluate all REGEX auto-label rules against a user message (synchronous).
 * Semantic rules are skipped here — see evaluateSemanticAutoLabels.
 * Returns deduplicated matches with normalized values, capped at MAX_MATCHES_PER_MESSAGE.
 *
 * @param message - The user's message text to scan
 * @param labels - The workspace label tree (from config)
 */
export function evaluateAutoLabels(
  message: string,
  labels: LabelConfig[],
): AutoLabelMatch[] {
  // Strip code blocks before scanning to avoid matching inside code
  const cleanMessage = stripCodeBlocks(message)

  const rules = collectAutoLabelRules(labels)
  const matches: AutoLabelMatch[] = []
  // Track seen entries to deduplicate (same label + same value = skip)
  const seen = new Set<string>()

  for (const { label, rule } of rules) {
    // Stop if we've hit the match limit
    if (matches.length >= MAX_MATCHES_PER_MESSAGE) break
    if (!isRegexAutoLabelRule(rule)) continue

    const ruleMatches = evaluateRegexRule(cleanMessage, label, rule)

    // Deduplicate and add to results (respecting match limit)
    for (const match of ruleMatches) {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) break

      const key = `${match.labelId}::${match.value}`
      if (!seen.has(key)) {
        seen.add(key)
        matches.push(match)
      }
    }
  }

  return matches
}

/**
 * Evaluate a regex-based auto-label rule.
 * Always enforces the 'g' flag to prevent infinite exec() loops.
 * Uses single-pass $N substitution to prevent injection.
 */
function evaluateRegexRule(
  message: string,
  label: LabelConfig,
  rule: RegexAutoLabelRule
): AutoLabelMatch[] {
  const matches: AutoLabelMatch[] = []

  try {
    // Ensure global flag is always present to prevent infinite exec() loops
    const flags = rule.flags
      ? (rule.flags.includes('g') ? rule.flags : rule.flags + 'g')
      : 'gi'
    const regex = new RegExp(rule.pattern, flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(message)) !== null) {
      // Single-pass $N substitution: prevents injection where captured text
      // contains $N patterns that would be double-substituted
      let value = rule.valueTemplate
        ? rule.valueTemplate.replace(/\$(\d+)/g, (_, n) => match![parseInt(n)] ?? '')
        : match[1] ?? match[0]

      // Normalize based on the label's declared valueType
      value = normalizeValue(value, label.valueType)

      matches.push({
        labelId: label.id,
        value,
        matchedText: match[0],
        via: 'regex',
      })

      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch (e) {
    // Invalid regex — skip silently (validation should catch this at config time)
    console.warn(`[AutoLabel] Invalid regex for label "${label.id}": ${rule.pattern}`, e)
  }

  return matches
}

// ============================================================
// Semantic rules (decision model)
// ============================================================

/** Runs one decision request; `null` = layer unavailable (fail closed → no matches). */
export type SemanticDecisionFn = (request: DecisionRequest) => Promise<DecisionResult | null>

/** Question key for the i-th semantic rule in a call. */
function semanticQuestionKey(index: number): string {
  return `rule_${index}`
}

/**
 * Build one decision request for a chunk of semantic rules: the code-stripped
 * message as state and one `noul` per rule.
 */
export function buildSemanticAutoLabelRequest(
  message: string,
  rules: Array<{ label: LabelConfig; rule: SemanticAutoLabelRule }>,
): DecisionRequest {
  const questions: Record<string, NoulQuestion> = {}
  rules.forEach(({ rule }, index) => {
    questions[semanticQuestionKey(index)] = {
      type: 'noul',
      instructions: rule.semantic,
    }
  })
  return { state: { user_message: message }, questions }
}

/**
 * Evaluate the SEMANTIC auto-label rules of the tree against a user message.
 *
 * Fail-closed by construction: no semantic rules, an empty message, or a
 * `null`/throwing `decide` all yield no matches. Never throws.
 */
export async function evaluateSemanticAutoLabels(
  message: string,
  labels: LabelConfig[],
  decide: SemanticDecisionFn,
  /** `skipEntries`: session label entries already applied; their rules are not asked again. */
  options: { skipEntries?: ReadonlySet<string> } = {},
): Promise<AutoLabelMatch[]> {
  const skip = options.skipEntries
  const rules = collectSemanticAutoLabelRules(labels).filter(({ label, rule }) => !skip?.has(semanticRuleEntry(label, rule)))
  if (rules.length === 0) return []

  const cleanMessage = stripCodeBlocks(message).trim().slice(0, SEMANTIC_RULE_MAX_MESSAGE_CHARS)
  if (cleanMessage.length < SEMANTIC_RULE_MIN_MESSAGE_CHARS) return []

  const matches: AutoLabelMatch[] = []
  const seen = new Set<string>()

  for (let offset = 0; offset < rules.length && matches.length < MAX_MATCHES_PER_MESSAGE; offset += SEMANTIC_RULES_PER_CALL) {
    const chunk = rules.slice(offset, offset + SEMANTIC_RULES_PER_CALL)
    let result: DecisionResult | null
    try {
      result = await decide(buildSemanticAutoLabelRequest(cleanMessage, chunk))
    } catch (e) {
      console.warn('[AutoLabel] Semantic rule evaluation failed:', e instanceof Error ? e.message : e)
      return matches
    }
    if (!result) return matches

    chunk.forEach(({ label, rule }, index) => {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) return
      const answer = result!.answers[semanticQuestionKey(index)]
      if (!answer || answer.type !== 'noul') return
      const threshold = typeof rule.threshold === 'number' && rule.threshold > 0 && rule.threshold <= 1
        ? rule.threshold
        : DEFAULT_SEMANTIC_RULE_THRESHOLD
      if (answer.noul < threshold) return

      const value = rule.value ? normalizeValue(rule.value, label.valueType) : ''
      const key = `${label.id}::${value}`
      if (seen.has(key)) return
      seen.add(key)
      matches.push({
        labelId: label.id,
        value,
        matchedText: rule.semantic,
        via: 'semantic',
        probability: answer.noul,
      })
    })
  }

  return matches
}
