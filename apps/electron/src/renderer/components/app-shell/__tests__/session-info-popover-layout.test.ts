/**
 * Pins the SessionInfoPopover layout contract: no fixed popover height,
 * viewport-capped, one scroll region below the pinned title, page-height
 * bottom drawer. Regression origin: a fixed h-[460px] plus overflow-hidden
 * panes clipped the Headroom rows and made the files list unreachable.
 *
 * Class-contract only (this suite has no DOM). Known, accepted residual risk
 * from the PR #188 review: the component could stop applying these constants
 * and this suite would stay green; mounting the component would require DOM
 * test infrastructure the repo does not have.
 */

import { describe, expect, it } from 'bun:test'
import {
  CONTENT_SCROLL_REGION_CLASS,
  DEFAULT_DRAWER_CONTENT_CLASS,
  DEFAULT_POPOVER_CONTENT_CLASS,
} from '../SessionInfoPopover.layout'

describe('SessionInfoPopover popover sizing', () => {
  it('does not hard-fix the popover height', () => {
    // A fixed h-[...] is what clipped the Headroom rows at 460px.
    expect(DEFAULT_POPOVER_CONTENT_CLASS).not.toMatch(/(?:^|\s)h-\[/)
  })

  it('caps height at the available viewport space Radix reports', () => {
    expect(DEFAULT_POPOVER_CONTENT_CLASS).toContain(
      'max-h-(--radix-popover-content-available-height)',
    )
  })

  it('lays out as a flex column so the scroll region can shrink below its content size', () => {
    expect(DEFAULT_POPOVER_CONTENT_CLASS).toContain('flex-col')
  })
})

describe('SessionInfoPopover content scroll region', () => {
  it('scrolls instead of clipping', () => {
    expect(CONTENT_SCROLL_REGION_CLASS).toContain('overflow-y-auto')
    expect(CONTENT_SCROLL_REGION_CLASS).not.toContain('overflow-hidden')
  })

  it('grows and shrinks inside the flex column without a zero flex-basis', () => {
    // `flex-1` sets flex-basis to 0, which collapses the region to nothing in
    // a content-sized (auto-height) column; `grow` keeps flex-basis auto so
    // the popover sizes to its content until the viewport cap kicks in.
    expect(CONTENT_SCROLL_REGION_CLASS).toContain('min-h-0')
    expect(CONTENT_SCROLL_REGION_CLASS).toMatch(/(?:^|\s)grow(?:\s|$)/)
    expect(CONTENT_SCROLL_REGION_CLASS).not.toMatch(/(?:^|\s)flex-1(?:\s|$)/)
  })
})

describe('SessionInfoPopover drawer (mobile presentation) sizing', () => {
  it('is page-height: exact height and max-height tokens, not just a substring', () => {
    // Both tokens asserted exactly — dropping the height while keeping the
    // max-height would silently return the drawer to content-sized behavior.
    expect(DEFAULT_DRAWER_CONTENT_CLASS).toContain(
      'data-[vaul-drawer-direction=bottom]:h-[calc(100dvh-1rem)]',
    )
    expect(DEFAULT_DRAWER_CONTENT_CLASS).toContain(
      'data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1rem)]',
    )
  })
})
