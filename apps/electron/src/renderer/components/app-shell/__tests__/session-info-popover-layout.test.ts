/**
 * Layout contract for the session Info popover (bottom-right "Info" button).
 *
 * The regression under test: with Headroom enabled, the Headroom report rows
 * plus the title row exceeded the popover's fixed 460px height, and because
 * every pane was `overflow-hidden` there was no scroll region anywhere — the
 * rest of the session info (including the files list) was unreachable.
 *
 * These assertions pin the layout contract that prevents that:
 *
 *   1. The popover must not hard-fix its height. It sizes to content and is
 *      capped by the viewport space Radix reports for it, so it can use as
 *      much screen real estate as it needs (matching the dropdown/context-menu
 *      precedent in components/ui).
 *   2. The region below the pinned title row must scroll, not clip.
 *   3. The mobile presentation (vaul bottom drawer) must be able to use the
 *      full dynamic viewport height, page-like, rather than a fixed cap that
 *      reproduces the same clipping on small screens.
 *
 * Tests are class-contract tests (no DOM), matching the conventions of this
 * suite — the components here are styled entirely through these constants.
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
  it('can occupy the full dynamic viewport height', () => {
    expect(DEFAULT_DRAWER_CONTENT_CLASS).toContain('100dvh')
  })
})
