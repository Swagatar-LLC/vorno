/**
 * The four-state truth table behind the local-recovery confirmation.
 *
 * These assertions exist because the i18n coverage gate cannot see them: it
 * verifies literal `t('...')` callsites, and this copy is chosen by returning a
 * key from a function. Without a test, renaming or dropping one of these four
 * keys would surface as a raw key string inside an irreversible warning dialog.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORGET_PUBLICATION_DETAIL_KEYS,
  forgetPublicationDetailKey,
} from '../page-forget-consent'

const LOCALES_DIR = join(import.meta.dir, '../../../../../packages/shared/src/i18n/locales')

function locale(code: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf8')) as Record<string, string>
}

describe('local-recovery confirmation copy', () => {
  test('maps each of the four states to its own key', () => {
    expect(forgetPublicationDetailKey('token-missing', false)).toBe('pages.share.forgetLocalBodyKeyMissing')
    expect(forgetPublicationDetailKey('token-missing', true)).toBe('pages.share.forgetLocalBodyKeyMissingRevoked')
    expect(forgetPublicationDetailKey('origin-unusable', false)).toBe('pages.share.forgetLocalBodyKeyHeld')
    expect(forgetPublicationDetailKey('origin-unusable', true)).toBe('pages.share.forgetLocalBodyKeyHeldRevoked')

    // Four inputs, four distinct outputs: no state borrows another's sentence.
    const produced = new Set([
      forgetPublicationDetailKey('token-missing', false),
      forgetPublicationDetailKey('token-missing', true),
      forgetPublicationDetailKey('origin-unusable', false),
      forgetPublicationDetailKey('origin-unusable', true),
    ])
    expect(produced.size).toBe(4)
    expect([...produced].sort()).toEqual([...FORGET_PUBLICATION_DETAIL_KEYS].sort())
  })

  test('every key it can return exists in every locale', () => {
    const codes = readdirSync(LOCALES_DIR).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    expect(codes.length).toBeGreaterThan(1)
    for (const code of codes) {
      const messages = locale(code)
      for (const key of FORGET_PUBLICATION_DETAIL_KEYS) {
        expect(messages[key], `${key} missing from ${code}.json`).toBeString()
        expect(messages[key]!.length).toBeGreaterThan(0)
      }
    }
  })

  test('never claims a missing key is being discarded', () => {
    const en = locale('en')
    for (const revoked of [false, true]) {
      const text = en[forgetPublicationDetailKey('token-missing', revoked)]!
      // The capability is already gone, so the action cannot be giving it up.
      expect(text).toContain('already missing')
      expect(text).not.toContain('key still exists')
    }
    for (const revoked of [false, true]) {
      const text = en[forgetPublicationDetailKey('origin-unusable', revoked)]!
      expect(text).toContain('still exists and will be discarded')
      expect(text).not.toContain('already missing')
    }
  })

  test('never says the copy may be online once revocation is confirmed', () => {
    const en = locale('en')
    for (const reason of ['token-missing', 'origin-unusable'] as const) {
      const revokedText = en[forgetPublicationDetailKey(reason, true)]!
      expect(revokedText).toContain('already revoked')
      expect(revokedText).toContain('not online')
      expect(revokedText).not.toContain('may still be online')
      // The remaining risk in this state is stored bytes, and it is stated.
      expect(revokedText).toContain('may remain on the server')

      const liveText = en[forgetPublicationDetailKey(reason, false)]!
      expect(liveText).toContain('may still be online')
      expect(liveText).not.toContain('already revoked')
    }
  })
})
