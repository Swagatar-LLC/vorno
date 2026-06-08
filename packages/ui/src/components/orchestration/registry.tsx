/**
 * Orchestration item-renderer registry.
 *
 * DIR-02 contribution seam.
 * -------------------------
 * The full skill-contribution registry (shapes/tools/views) is NOT built yet.
 * This small typed registry is the early seam for it: a future skill-contributed
 * `view` can register a custom React renderer for a specific orchestration item
 * `kind` (or a skill-defined kind) without touching the panel itself. When the
 * real contribution registry lands, it should drive registrations through this
 * same `registerOrchestrationItemRenderer` API.
 *
 * Until then the panel ships a single `DefaultOrchestrationItem` renderer, used
 * for every built-in kind.
 */

import * as React from 'react'
import type { OrchestrationItem } from './types'
import { DefaultOrchestrationItem, type OrchestrationItemRendererProps } from './DefaultOrchestrationItem'

export type { OrchestrationItemRendererProps }

/** A renderer is any component taking the standard orchestration item props. */
export type OrchestrationItemRenderer = React.ComponentType<OrchestrationItemRendererProps>

/** Registry keyed by item `kind`. */
const renderers = new Map<string, OrchestrationItemRenderer>()

/**
 * Register a custom renderer for an orchestration item kind.
 * A later registration for the same kind overrides the earlier one.
 *
 * @returns an unregister function (restores the previous renderer, if any).
 */
export function registerOrchestrationItemRenderer(
  kind: string,
  renderer: OrchestrationItemRenderer,
): () => void {
  const previous = renderers.get(kind)
  renderers.set(kind, renderer)
  return () => {
    if (previous) renderers.set(kind, previous)
    else renderers.delete(kind)
  }
}

/** Resolve the renderer for an item, falling back to the default. */
export function getOrchestrationItemRenderer(item: OrchestrationItem): OrchestrationItemRenderer {
  return renderers.get(item.kind) ?? DefaultOrchestrationItem
}
