import { describe, it, expect } from 'bun:test'
import type { LabelConfig } from '../types.ts'
import type { DecisionRequest, DecisionResult } from '../../decisions/types.ts'
import {
  autoLabelMatchToEntry,
  buildSemanticAutoLabelRequest,
  collectAutoLabelRules,
  collectSemanticAutoLabelRules,
  evaluateAutoLabels,
  evaluateSemanticAutoLabels,
  semanticRuleEntry,
} from './evaluator.ts'
import { validateSemanticAutoLabelRule } from './validation.ts'

const LABELS: LabelConfig[] = [
  {
    id: 'linear-issue',
    name: 'Linear Issue',
    valueType: 'string',
    autoRules: [{ pattern: '\\b([A-Z]{2,5}-\\d+)\\b', valueTemplate: '$1' }],
  },
  {
    id: 'billing',
    name: 'Billing',
    autoRules: [{ semantic: 'Is the user asking about billing, invoices or charges?' }],
  },
  {
    id: 'area',
    name: 'Area',
    valueType: 'string',
    children: [
      {
        id: 'mobile',
        name: 'Mobile',
        autoRules: [{ semantic: 'Is this about the iOS or Android app?', threshold: 0.6, value: 'mobile-app' }],
      },
    ],
  },
]

function resultFor(request: DecisionRequest, nouls: number[]): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  Object.keys(request.questions).forEach((key, i) => { answers[key] = { type: 'noul', noul: nouls[i] ?? 0 } })
  return {
    model: 'jev-1.13.0',
    modelReported: true,
    requestedModel: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 10, outputTokens: 1 },
    latencyMs: 40,
    state: { sha256: 'x', bytes: 10, truncated: false },
  }
}

describe('auto-label rules: regex path stays synchronous and ignores semantic rules', () => {
  it('collects both kinds but evaluates only regex rules synchronously', () => {
    expect(collectAutoLabelRules(LABELS)).toHaveLength(3)
    expect(collectSemanticAutoLabelRules(LABELS).map(r => r.label.id)).toEqual(['billing', 'mobile'])
    const matches = evaluateAutoLabels('Please look at CRA-123, my invoice is wrong', LABELS)
    expect(matches).toEqual([{ labelId: 'linear-issue', value: 'CRA-123', matchedText: 'CRA-123', via: 'regex' }])
  })

  it('formats entries: regex keeps the historical id::value form, semantic plain matches use the bare id', () => {
    expect(autoLabelMatchToEntry({ labelId: 'linear-issue', value: 'CRA-1', matchedText: 'CRA-1', via: 'regex' })).toBe('linear-issue::CRA-1')
    // empty regex capture → unchanged legacy form, so existing sessions do not get duplicate chips
    expect(autoLabelMatchToEntry({ labelId: 'budget', value: '', matchedText: 'budget:', via: 'regex' })).toBe('budget::')
    expect(autoLabelMatchToEntry({ labelId: 'budget', value: '', matchedText: 'budget:' })).toBe('budget::')
    expect(autoLabelMatchToEntry({ labelId: 'billing', value: '', matchedText: 'q', via: 'semantic' })).toBe('billing')
    expect(autoLabelMatchToEntry({ labelId: 'area', value: 'mobile-app', matchedText: 'q', via: 'semantic' })).toBe('area::mobile-app')
  })

  it('treats a hybrid pattern+semantic rule as a regex rule everywhere', () => {
    const hybrid: LabelConfig[] = [{ id: 'h', name: 'H', autoRules: [{ pattern: 'foo', semantic: 'Is it foo?' } as never] }]
    expect(collectSemanticAutoLabelRules(hybrid)).toHaveLength(0)
    expect(evaluateAutoLabels('foo bar', hybrid)).toHaveLength(1)
  })
})

describe('evaluateSemanticAutoLabels', () => {
  it('asks one noul per semantic rule on the code-stripped message and applies labels above the threshold', async () => {
    let seen: DecisionRequest | undefined
    const matches = await evaluateSemanticAutoLabels(
      'My invoice shows two charges. ```console.log("mobile")```',
      LABELS,
      async (request) => { seen = request; return resultFor(request, [0.96, 0.3]) },
    )
    expect(seen).toBeDefined()
    expect(Object.values(seen!.questions).map(q => q.type)).toEqual(['noul', 'noul'])
    expect(String(Object.values(seen!.questions)[0]!.instructions)).toContain('billing')
    expect((seen!.state as Record<string, string>).user_message).toBe('My invoice shows two charges.')
    expect(matches).toEqual([
      { labelId: 'billing', value: '', matchedText: 'Is the user asking about billing, invoices or charges?', via: 'semantic', probability: 0.96 },
    ])
  })

  it('skips rules whose label entry the session already has (no question asked)', async () => {
    let seen: DecisionRequest | undefined
    const matches = await evaluateSemanticAutoLabels(
      'The Android app crashes when I open an invoice',
      LABELS,
      async (request) => { seen = request; return resultFor(request, [0.99]) },
      { skipEntries: new Set(['billing']) },
    )
    expect(Object.keys(seen!.questions)).toHaveLength(1)
    expect(String(Object.values(seen!.questions)[0]!.instructions)).toContain('Android')
    expect(matches.map(m => m.labelId)).toEqual(['mobile'])

    let calls = 0
    const all = new Set(collectSemanticAutoLabelRules(LABELS).map(({ label, rule }) => semanticRuleEntry(label, rule)))
    expect(all).toEqual(new Set(['billing', 'mobile::mobile-app']))
    expect(await evaluateSemanticAutoLabels('The Android app crashes on an invoice', LABELS, async (r) => { calls++; return resultFor(r, [1, 1]) }, { skipEntries: all })).toEqual([])
    expect(calls).toBe(0)
  })

  it('honours per-rule thresholds and fixed values', async () => {
    const matches = await evaluateSemanticAutoLabels('The Android app crashes on launch', LABELS, async (request) => resultFor(request, [0.85, 0.65]))
    // billing: 0.85 < default 0.9 → no; mobile: 0.65 >= 0.6 → yes with the fixed value
    expect(matches).toEqual([
      { labelId: 'mobile', value: 'mobile-app', matchedText: 'Is this about the iOS or Android app?', via: 'semantic', probability: 0.65 },
    ])
    expect(autoLabelMatchToEntry(matches[0]!)).toBe('mobile::mobile-app')
  })

  it('fails closed: no rules, empty or trivial message, null result, thrown error', async () => {
    let calls = 0
    const counting = async (request: DecisionRequest) => { calls += 1; return resultFor(request, [1, 1]) }
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', [LABELS[0]!], counting)).toEqual([])
    expect(await evaluateSemanticAutoLabels('```only code```', LABELS, counting)).toEqual([])
    expect(await evaluateSemanticAutoLabels('ok thanks', LABELS, counting)).toEqual([]) // below the length floor
    expect(calls).toBe(0)
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', LABELS, async () => null)).toEqual([])
    expect(await evaluateSemanticAutoLabels('hello there, this is long enough', LABELS, async () => { throw new Error('down') })).toEqual([])
  })

  it('chunks many rules into several calls', async () => {
    const many: LabelConfig[] = Array.from({ length: 45 }, (_, i) => ({
      id: `l${i}`,
      name: `L${i}`,
      autoRules: [{ semantic: `Question ${i}?` }],
    }))
    const sizes: number[] = []
    const matches = await evaluateSemanticAutoLabels('a message long enough to be judged', many, async (request) => {
      const n = Object.keys(request.questions).length
      sizes.push(n)
      return resultFor(request, Array.from({ length: n }, () => 0))
    })
    expect(sizes).toEqual([20, 20, 5])
    expect(matches).toEqual([])
  })

  it('buildSemanticAutoLabelRequest keys rules by position', () => {
    const request = buildSemanticAutoLabelRequest('msg', collectSemanticAutoLabelRules(LABELS))
    expect(Object.keys(request.questions)).toEqual(['rule_0', 'rule_1'])
  })
})

describe('validateSemanticAutoLabelRule', () => {
  it('accepts a plain question and flags bad thresholds', () => {
    expect(validateSemanticAutoLabelRule({ semantic: 'Is the user asking about billing?' }).valid).toBe(true)
    expect(validateSemanticAutoLabelRule({ semantic: '' }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 1.2 }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 0 }).valid).toBe(false)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', threshold: 0.3 }).warnings.length).toBeGreaterThan(0)
    expect(validateSemanticAutoLabelRule({ semantic: 'billing stuff' }).warnings.length).toBeGreaterThan(0)
    expect(validateSemanticAutoLabelRule({ semantic: 'Is it urgent?', value: 5 as unknown as string }).valid).toBe(false)
  })
})
