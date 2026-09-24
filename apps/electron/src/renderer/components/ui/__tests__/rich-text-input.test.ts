import { describe, it, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isEscapeDuringComposition, RichTextInput } from '../rich-text-input'

it('merges caller sizing styles without dropping the default editor line-height', () => {
  const html = renderToStaticMarkup(createElement(RichTextInput, {
    value: 'Draft', onChange: () => {}, style: { maxHeight: 180 },
  }))
  expect(html).toContain('line-height:1.25')
  expect(html).toContain('max-height:180px')
})

it('allows an explicit caller line-height override', () => {
  const html = renderToStaticMarkup(createElement(RichTextInput, {
    value: 'Draft', onChange: () => {}, style: { lineHeight: 1.5 },
  }))
  expect(html).toContain('line-height:1.5')
})

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})
