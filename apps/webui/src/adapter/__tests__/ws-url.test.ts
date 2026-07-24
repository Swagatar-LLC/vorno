import { describe, expect, test } from 'bun:test'
import { resolvePageWsUrl } from '../ws-url'

describe('resolvePageWsUrl', () => {
  test('upgrades ws:// to wss:// when page is https:', () => {
    expect(resolvePageWsUrl('ws://h/ws', 'https:')).toBe('wss://h/ws')
  })

  test('leaves ws:// as-is when page is http:', () => {
    expect(resolvePageWsUrl('ws://h/ws', 'http:')).toBe('ws://h/ws')
  })

  test('leaves wss:// as-is when page is https: (idempotent)', () => {
    expect(resolvePageWsUrl('wss://h/ws', 'https:')).toBe('wss://h/ws')
  })

  test('never downgrades wss:// to ws://', () => {
    expect(resolvePageWsUrl('wss://h/ws', 'http:')).toBe('wss://h/ws')
  })
})
