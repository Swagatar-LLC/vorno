/**
 * View model for the Memory section of Workspace Settings
 * (fork: PLAN-040, SUV-0029 + SUV-0040; ADR-0031).
 *
 * A deliberate near-copy of `headroom-settings.ts`, for the reason ADR-0031
 * gives for the near-copy one layer down: two config surfaces in one product
 * that report provenance differently, or that disagree about what "clear this
 * field" means, is a bug the day someone has to explain the difference. The
 * duplication is the cheaper of the two.
 *
 * The renderer holds **no config logic**. Every effective value and every
 * "where did this come from" answer is computed by the resolver in
 * `@craft-agent/core/types` and arrives pre-resolved in
 * `WorkspaceSettings.memoryView`. This module only
 *
 *   1. flattens that payload into one row per field, in a stable order, and
 *   2. builds the next *workspace override layer* for a set or a clear.
 *
 * (2) is object bookkeeping, not precedence: it never merges layers and never
 * decides what a field falls back to — it hands the storage layer a new
 * workspace layer and lets the resolver do the rest on the next read.
 *
 * Note what is *not* here: anything about what a provider can do. Capabilities
 * are live host state, not configuration, and they come from the provider's own
 * `describe()` over `vorno:memory:capabilities:get`. Nothing in this file may
 * ever branch on a provider id.
 *
 * The `view === undefined` path is the fresh-install path (and the path for a
 * client talking to a server that predates this field): everything reads from
 * `MEMORY_CONFIG_DEFAULTS`, so the toggle renders **off** rather than throwing
 * or rendering blank.
 */

import {
  MEMORY_CONFIG_DEFAULTS,
  MEMORY_CONFIG_FIELDS,
} from '@craft-agent/core/types'
import type {
  MemoryConfig,
  MemoryConfigField,
  MemoryConfigOverrides,
  MemoryConfigSource,
  MemoryConfigSources,
} from '@craft-agent/core/types'
import type { MemoryConfigViewDto } from '@craft-agent/shared/protocol'

/** One editable field, resolved and attributed. */
export interface MemoryFieldRow {
  field: MemoryConfigField
  /** Effective value — what this workspace actually gets today. */
  value: MemoryConfig[MemoryConfigField]
  /** What the field would revert to if the workspace override were cleared. */
  instanceValue: MemoryConfig[MemoryConfigField]
  /** Which layer supplied `value` (three-valued; see `overridden`). */
  source: MemoryConfigSource
  /**
   * Whether this workspace sets the field itself. The section's two-way
   * "workspace override / instance default" label folds `instance` and
   * `default` together here — both mean "not set by this workspace", which is
   * the only distinction the Clear affordance cares about.
   */
  overridden: boolean
}

/** Every field defaulted — the fresh-install view. */
const EMPTY_SOURCES: MemoryConfigSources = {
  enabled: 'default',
  provider: 'default',
  topK: 'default',
  autoLoad: 'default',
  autoSave: 'default',
  decayHalfLifeDays: 'default',
  includeArchived: 'default',
}

/**
 * Normalise the (possibly absent) DTO into a view that always has an
 * effective config, an instance fallback, and a source per field.
 */
export function normalizeMemoryView(
  view: MemoryConfigViewDto | undefined,
): Required<Omit<MemoryConfigViewDto, 'overrides'>> & {
  overrides: MemoryConfigOverrides | undefined
} {
  return {
    effective: view?.effective ?? { ...MEMORY_CONFIG_DEFAULTS },
    instanceEffective: view?.instanceEffective ?? { ...MEMORY_CONFIG_DEFAULTS },
    overrides: view?.overrides,
    sources: view?.sources ?? EMPTY_SOURCES,
  }
}

/**
 * One row per memory option, in `MEMORY_CONFIG_FIELDS` order.
 *
 * Iterating the exported field list rather than a local literal is what keeps
 * this surface honest: a field added to `MemoryConfig` shows up here without an
 * edit, so a new knob cannot ship silently un-editable.
 */
export function buildMemoryRows(
  view: MemoryConfigViewDto | undefined,
): MemoryFieldRow[] {
  const { effective, instanceEffective, sources } = normalizeMemoryView(view)

  return MEMORY_CONFIG_FIELDS.map((field) => ({
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
 * through untouched — the same forward-compatibility the layer validator
 * preserves when it ignores unknown keys instead of rejecting the layer.
 */
export function withMemoryOverride<K extends MemoryConfigField>(
  view: MemoryConfigViewDto | undefined,
  field: K,
  value: MemoryConfig[K],
): MemoryConfigOverrides {
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
export function withoutMemoryOverride(
  view: MemoryConfigViewDto | undefined,
  field: MemoryConfigField,
): MemoryConfigOverrides | undefined {
  const next: MemoryConfigOverrides = { ...(view?.overrides ?? {}) }
  delete next[field]
  return Object.keys(next).length > 0 ? next : undefined
}
