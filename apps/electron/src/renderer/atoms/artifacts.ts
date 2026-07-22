/**
 * Artifact-plane atoms (Artifact Home — ADR-0015/0016, PLAN-025 C1).
 *
 * Jotai state for the generalized workspace artifact surface. Like the
 * workbench (PLAN-024), C1 has no push events: the page refetches on
 * mount/focus/mutation and writes back through these atoms. All data comes from
 * `window.electronAPI.artifacts*` (the `vorno:artifacts:*` wire contract);
 * atoms here are pure client cache + filter/selection state.
 */

import { atom } from 'jotai'
import type { ArtifactsIndexResult, ArtifactsReadResult } from '../../shared/types'
import type { ArtifactTypeDescriptor } from '@craft-agent/core'

// -----------------------------------------------------------------------------
// Filters (client-driven; server applies the server-side subset via index req)
// -----------------------------------------------------------------------------

/**
 * Filter-rail state. `type`/`originKind`/`projectId`/`label`/`sessionStatus` are
 * sent to the server as index filters; `pinnedOnly`, `titleQuery`, and
 * `showArchived`'s client half are applied in-page. `showArchived` is also
 * forwarded to the server as `includeArchived`.
 */
export interface ArtifactFilters {
  type: string | null
  originKind: string | null
  projectId: string | null
  label: string | null
  sessionStatus: string | null
  pinnedOnly: boolean
  showArchived: boolean
  /** Client-side title substring search. */
  titleQuery: string
}

export const EMPTY_ARTIFACT_FILTERS: ArtifactFilters = {
  type: null,
  originKind: null,
  projectId: null,
  label: null,
  sessionStatus: null,
  pinnedOnly: false,
  showArchived: false,
  titleQuery: '',
}

export const artifactFiltersAtom = atom<ArtifactFilters>(EMPTY_ARTIFACT_FILTERS)

// -----------------------------------------------------------------------------
// Index + registry
// -----------------------------------------------------------------------------

/** Result of the most recent artifact index (server-filtered). */
export const artifactsIndexAtom = atom<ArtifactsIndexResult | null>(null)

/** The open type registry (loaded once per page mount). */
export const artifactTypesAtom = atom<ArtifactTypeDescriptor[]>([])

// -----------------------------------------------------------------------------
// Selection + read
// -----------------------------------------------------------------------------

/** Currently selected artifact uri (`vorno-artifact://…`). */
export const selectedArtifactUriAtom = atom<string | null>(null)

/** Read result (content + version + type) for the selected artifact. */
export const selectedArtifactReadAtom = atom<ArtifactsReadResult | null>(null)
