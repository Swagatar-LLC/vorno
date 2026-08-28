/**
 * Headroom settings view model (fork: PLAN-040, SUV-0017).
 *
 * Two things the renderer must get right and nothing else covers:
 *
 *   1. The fresh-install / older-server path (`view === undefined`) renders a
 *      real section with the toggle **off**, rather than blank or throwing.
 *   2. Setting and clearing a field produce the right *workspace override
 *      layer* — including the two easy-to-get-wrong cases: clearing the last
 *      override yields no layer at all, and an unknown key written by a newer
 *      build rides through an edit untouched.
 *
 * Nothing here recomputes precedence — that is the resolver's job, tested in
 * `packages/shared`. These tests assert the section renders what the resolver
 * said and writes back what the storage layer expects.
 */

import { describe, expect, it } from 'bun:test'
import { HEADROOM_CONFIG_DEFAULTS } from '@craft-agent/core/types'
import type { HeadroomConfigViewDto } from '@craft-agent/shared/protocol'
import {
  buildHeadroomRows,
  formatCompressionEngines,
  normalizeHeadroomView,
  parseCompressionEngines,
  withHeadroomOverride,
  withoutHeadroomOverride,
} from '../headroom-settings'

const VIEW: HeadroomConfigViewDto = {
  effective: {
    enabled: true,
    compressionEngines: ['summarize'],
    verbosity: 'verbose',
    exposeStats: false,
  },
  instanceEffective: {
    enabled: false,
    compressionEngines: [],
    verbosity: 'verbose',
    exposeStats: false,
  },
  overrides: { enabled: true, compressionEngines: ['summarize'] },
  sources: {
    enabled: 'workspace',
    compressionEngines: 'workspace',
    verbosity: 'instance',
    exposeStats: 'default',
  },
}

describe('fresh-install path (no headroom config anywhere)', () => {
  it('normalizes an absent view to the disabled defaults', () => {
    const normalized = normalizeHeadroomView(undefined)

    expect(normalized.effective).toEqual(HEADROOM_CONFIG_DEFAULTS)
    expect(normalized.instanceEffective).toEqual(HEADROOM_CONFIG_DEFAULTS)
    expect(normalized.overrides).toBeUndefined()
  })

  it('renders every field, with the enable toggle off and nothing overridden', () => {
    const rows = buildHeadroomRows(undefined)

    expect(rows.map((r) => r.field)).toEqual([
      'enabled',
      'compressionEngines',
      'verbosity',
      'exposeStats',
    ])
    expect(rows.find((r) => r.field === 'enabled')?.value).toBe(false)
    expect(rows.every((r) => r.source === 'default')).toBe(true)
    expect(rows.some((r) => r.overridden)).toBe(false)
  })

  it('does not hand back a mutable reference to the shared defaults', () => {
    const first = normalizeHeadroomView(undefined)
    first.effective.enabled = true
    expect(normalizeHeadroomView(undefined).effective.enabled).toBe(false)
    expect(HEADROOM_CONFIG_DEFAULTS.enabled).toBe(false)
  })
})

describe('rows carry the resolver’s answer, unmodified', () => {
  it('pairs each effective value with its source and instance fallback', () => {
    const rows = buildHeadroomRows(VIEW)
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]))

    expect(byField.enabled).toMatchObject({
      value: true,
      instanceValue: false,
      source: 'workspace',
      overridden: true,
    })
    expect(byField.verbosity).toMatchObject({
      value: 'verbose',
      source: 'instance',
      overridden: false,
    })
    expect(byField.exposeStats).toMatchObject({ source: 'default', overridden: false })
  })

  it('folds instance and default into "not overridden" for the Clear affordance', () => {
    const rows = buildHeadroomRows(VIEW)
    // Three-valued source is preserved; the two-way label derives from it.
    expect(rows.filter((r) => r.overridden).map((r) => r.field)).toEqual([
      'enabled',
      'compressionEngines',
    ])
    expect(rows.map((r) => r.source)).toEqual([
      'workspace',
      'workspace',
      'instance',
      'default',
    ])
  })
})

describe('building the next workspace override layer', () => {
  it('adds a field without disturbing the others', () => {
    expect(withHeadroomOverride(VIEW, 'verbosity', 'terse')).toEqual({
      enabled: true,
      compressionEngines: ['summarize'],
      verbosity: 'terse',
    })
  })

  it('starts a layer from nothing on a fresh install', () => {
    expect(withHeadroomOverride(undefined, 'enabled', true)).toEqual({ enabled: true })
  })

  it('removes one field and keeps the rest', () => {
    expect(withoutHeadroomOverride(VIEW, 'enabled')).toEqual({
      compressionEngines: ['summarize'],
    })
  })

  it('returns undefined once the last override is cleared', () => {
    const single: HeadroomConfigViewDto = { ...VIEW, overrides: { enabled: true } }
    expect(withoutHeadroomOverride(single, 'enabled')).toBeUndefined()
    expect(withoutHeadroomOverride(undefined, 'enabled')).toBeUndefined()
  })

  it('never mutates the view it was handed', () => {
    withHeadroomOverride(VIEW, 'verbosity', 'terse')
    withoutHeadroomOverride(VIEW, 'enabled')
    expect(VIEW.overrides).toEqual({ enabled: true, compressionEngines: ['summarize'] })
  })

  it('carries an unknown key from a newer build through an edit', () => {
    const forward = {
      ...VIEW,
      overrides: { enabled: true, futureKnob: 'x' },
    } as unknown as HeadroomConfigViewDto

    expect(withHeadroomOverride(forward, 'verbosity', 'terse')).toEqual({
      enabled: true,
      futureKnob: 'x',
      verbosity: 'terse',
    } as never)
    expect(withoutHeadroomOverride(forward, 'enabled')).toEqual({
      futureKnob: 'x',
    } as never)
  })
})

describe('compression-engine text field', () => {
  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(parseCompressionEngines(' summarize , trim ,, ')).toEqual(['summarize', 'trim'])
  })

  it('treats an empty field as "no compression", not as an empty id', () => {
    expect(parseCompressionEngines('')).toEqual([])
    expect(parseCompressionEngines('   ')).toEqual([])
  })

  it('preserves order — the list is a preference ranking', () => {
    expect(parseCompressionEngines('c,b,a')).toEqual(['c', 'b', 'a'])
  })

  it('round-trips through the display format', () => {
    const engines = ['summarize', 'trim']
    expect(parseCompressionEngines(formatCompressionEngines(engines))).toEqual(engines)
    expect(formatCompressionEngines([])).toBe('')
  })
})
