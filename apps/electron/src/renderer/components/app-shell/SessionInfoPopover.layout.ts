/**
 * Layout contract for SessionInfoPopover, kept importable without the
 * component's runtime dependencies (the component tree touches `window` at
 * module scope) so the __tests__ suite can pin it.
 *
 * The contract exists because of a regression: a fixed popover height plus
 * overflow-hidden panes clipped the Headroom report rows and made everything
 * below them (the session files list) unreachable. The rules:
 *
 * - The popover sizes to its content and is capped by the viewport space
 *   Radix reports (`--radix-popover-content-available-height`, same pattern
 *   as dropdown-menu/context-menu in components/ui). No fixed height.
 * - Everything below the pinned title row lives in one scroll region that
 *   scrolls instead of clipping. The region uses `grow` (flex-basis auto),
 *   not `flex-1` (flex-basis 0), because a zero basis collapses it inside a
 *   content-sized column.
 * - The bottom drawer (mobile presentation) takes the full dynamic viewport
 *   height minus its insets, page-like, and relies on the same scroll region.
 */

export const DEFAULT_POPOVER_CONTENT_CLASS = 'flex flex-col w-[360px] min-w-[200px] max-w-[420px] max-h-(--radix-popover-content-available-height) overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'

export const DEFAULT_DRAWER_CONTENT_CLASS = [
  'data-[vaul-drawer-direction=bottom]:inset-x-2',
  'data-[vaul-drawer-direction=bottom]:bottom-2',
  'data-[vaul-drawer-direction=bottom]:mt-0',
  'data-[vaul-drawer-direction=bottom]:h-[calc(100dvh-1rem)]',
  'data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1rem)]',
  'overflow-hidden rounded-[14px] border border-border/60 bg-background shadow-modal-small',
].join(' ')

export const CONTENT_SCROLL_REGION_CLASS = 'grow min-h-0 overflow-y-auto'
