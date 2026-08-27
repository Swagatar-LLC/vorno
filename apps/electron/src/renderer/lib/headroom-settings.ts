/**
 * View model for the Headroom section of Workspace Settings
 * (fork: PLAN-040, SUV-0017).
 *
 * The renderer holds **no config logic**: every effective value and every
 * "where did this come from" answer is computed by the SUV-0016 resolver and
 * arrives pre-resolved in `WorkspaceSettings.headroom`. This module only
 *
 *   1. flattens that payload into one row per field, in a stable order, and
 *   2. builds the next *workspace override layer* for a set or a clear.
 *
 * (2) is object bookkeeping, not precedence: it never merges layers and never
 * decides what a field falls back to — it hands the storage layer a new
 * workspace layer and lets the resolver do the rest on the next read.
 *
 * The `view === undefined` path is the fresh-install path (and the path for a
 * client talking to a server that predates this field): everything reads from
 * `HEADROOM_CONFIG_DEFAULTS`, so the toggle renders **off** rather than
 * throwing or rendering blank.
 */

import {
  HEADROOM_CONFIG_DEFAULTS,
  HEADROOM_CONFIG_FIELDS,
} from '@craft-agent/core/types'
import type {
  HeadroomConfig,
  HeadroomConfigField,
  HeadroomConfigOverrides,
  HeadroomConfigSource,
  HeadroomConfigSources,
} from '@craft-agent/core/types'
import type { HeadroomConfigViewDto } from '@craft-agent/shared/protocol'

/** One editable field, resolved and attributed. */
export interface HeadroomFieldRow {
  field: HeadroomConfigField
  /** Effective value — what this workspace actually gets today. */
  value: HeadroomConfig[HeadroomConfigField]
  /** What the field would revert to if the workspace override were cleared. */
  instanceValue: HeadroomConfig[HeadroomConfigField]
  /** Which layer supplied `value` (three-valued; see `overridden`). */
  source: HeadroomConfigSource
  /**
   * Whether this workspace sets the field itself. The section's two-way
   * "workspace override / instance default" label folds `instance` and
   * `default` together here — both mean "not set by this workspace", which is
   * the only distinction the Clear affordance cares about.
   */
  overridden: boolean
}

/** Every field defaulted — the fresh-install view. */
const EMPTY_SOURCES: HeadroomConfigSources = {
  enabled: 'default',
  compressionEngines: 'default',
  verbosity: 'default',
  exposeStats: 'default',
}

/**
 * Normalise the (possibly absent) DTO into a view that always has an
 * effective config, an instance fallback, and a source per field.
 */
export function normalizeHeadroomView(
  view: HeadroomConfigViewDto | undefined,
): Required<Omit<HeadroomConfigViewDto, 'overrides'>> & {
  overrides: HeadroomConfigOverrides | undefined
} {
  return {
    effective: view?.effective ?? { ...HEADROOM_CONFIG_DEFAULTS },
    instanceEffective: view?.instanceEffective ?? { ...HEADROOM_CONFIG_DEFAULTS },
    overrides: view?.overrides,
    sources: view?.sources ?? EMPTY_SOURCES,
  }
}

/** One row per Headroom option, in `HEADROOM_CONFIG_FIELDS` order. */
export function buildHeadroomRows(
  view: HeadroomConfigViewDto | undefined,
): HeadroomFieldRow[] {
  const { effective, instanceEffective, sources } = normalizeHeadroomView(view)

  return HEADROOM_CONFIG_FIELDS.map((field) => ({
    field,
    value: effective[field],
    instanceValue: instanceEffective[field],
    source: sources[field],
    overridden: sources[field] === 'workspace',
  }))
}

/**
 * The workspace override layer to persist after setting one field.
 *
 * Spreads the layer *as stored* so keys this build does not know about ride
 * through untouched — the same forward-compatibility the SUV-0016 validator
 * preserves when it ignores unknown keys instead of rejecting the layer.
 */
export function withHeadroomOverride<K extends HeadroomConfigField>(
  view: HeadroomConfigViewDto | undefined,
  field: K,
  value: HeadroomConfig[K],
): HeadroomConfigOverrides {
  return { ...(view?.overrides ?? {}), [field]: value }
}

/**
 * The workspace override layer to persist after clearing one field, or
 * `undefined` when nothing is left to store.
 *
 * Returning `undefined` for an emptied layer keeps "this workspace overrides
 * nothing" as an absent key rather than an empty object — the two resolve
 * identically, and the absent form is what a workspace that never opened this
 * screen looks like.
 */
export function withoutHeadroomOverride(
  view: HeadroomConfigViewDto | undefined,
  field: HeadroomConfigField,
): HeadroomConfigOverrides | undefined {
  const next: HeadroomConfigOverrides = { ...(view?.overrides ?? {}) }
  delete next[field]
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Parse the comma-separated engine-list text field into ordered ids.
 *
 * Presentation only: engine ids are opaque strings to us (SUV-0016 is explicit
 * that the real catalogue is whatever the pinned SDK exposes), so this trims,
 * drops empties, and preserves order — it validates nothing.
 */
export function parseCompressionEngines(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Render an engine list back into the text field's value. */
export function formatCompressionEngines(engines: readonly string[]): string {
  return engines.join(', ')
}
