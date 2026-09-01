/**
 * Layout contract for SessionInfoPopover, in its own module so the __tests__
 * suite can import it — the component's import chain touches `window` at
 * module scope. Load-bearing constraint: the scroll region uses `grow`
 * (flex-basis auto), never `flex-1` (flex-basis 0), because a zero basis
 * collapses inside the content-sized popover column.
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
