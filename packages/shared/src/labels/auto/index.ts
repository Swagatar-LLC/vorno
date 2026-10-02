export type { AutoLabelMatch } from './types.ts'
export {
  evaluateAutoLabels,
  evaluateSemanticAutoLabels,
  buildSemanticAutoLabelRequest,
  collectAutoLabelRules,
  collectSemanticAutoLabelRules,
  autoLabelMatchToEntry,
  semanticRuleEntry,
  SEMANTIC_RULE_MAX_MESSAGE_CHARS,
  SEMANTIC_RULE_MIN_MESSAGE_CHARS,
} from './evaluator.ts'
export type { SemanticDecisionFn } from './evaluator.ts'
export { normalizeValue } from './normalize.ts'
export { validateAutoLabelRule, validateSemanticAutoLabelRule, SEMANTIC_RULE_MAX_QUESTION_CHARS } from './validation.ts'
