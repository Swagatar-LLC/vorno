/**
 * Regression cover for the highest-damage error in the VIEWER_URL flip
 * (ADR-0024, PLAN-035).
 *
 * If update/revoke followed the VIEWER_URL constant instead of the share's own
 * stored URL, every share created before the cutover would 404 against the new
 * backend — "Failed to revoke share" in the UI, and the user's transcript left
 * public on upstream's storage with no way to take it down from inside the app.
 */

import { describe, it, expect } from 'bun:test'
import { shareApiBase } from './share-target'

const VORNO = 'https://share.vorno.ai'
const UPSTREAM = 'https://agents.craft.do'

describe('shareApiBase', () => {
  it('sends a pre-cutover share back to the backend that holds it', () => {
    // The whole point: VIEWER_URL has already flipped, and this must not follow it.
    expect(shareApiBase(`${UPSTREAM}/s/tz5-13I84pwK_he`, VORNO)).toBe(UPSTREAM)
  })

  it('keeps a Vorno-hosted share on Vorno', () => {
    expect(shareApiBase(`${VORNO}/s/AbCdEf0123456789_-xyz`, VORNO)).toBe(VORNO)
  })

  it('falls back to the current backend when there is no stored URL', () => {
    // Creating a new share, or metadata that predates sharedUrl being persisted.
    expect(shareApiBase(undefined, VORNO)).toBe(VORNO)
    expect(shareApiBase('', VORNO)).toBe(VORNO)
  })

  it('degrades to the fallback on an unparseable stored URL rather than throwing', () => {
    // A malformed persisted value should not be able to break revoke entirely.
    expect(shareApiBase('not a url', VORNO)).toBe(VORNO)
    expect(shareApiBase('/s/abc', VORNO)).toBe(VORNO)
  })

  it('returns the origin only — never a path, query or fragment', () => {
    expect(shareApiBase(`${UPSTREAM}/s/abc?x=1#y`, VORNO)).toBe(UPSTREAM)
  })

  it('preserves a non-default port', () => {
    expect(shareApiBase('http://localhost:8787/s/abc', VORNO)).toBe('http://localhost:8787')
  })
})
