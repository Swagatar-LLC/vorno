/**
 * Workbench atoms (Review Workbench — ADR-0014, PLAN-024).
 *
 * Jotai state for the first dynamic-workspace surface. v0.1 has no push
 * events: the page refetches on selection/focus and writes back through these
 * atoms. All data comes from `window.electronAPI.workbench*` (the frozen RPC
 * contract); atoms here are pure client cache + selection state.
 */

import { atom } from 'jotai'
import type {
  WorkbenchInstanceV1,
  ReviewThreadV1,
  WorkbenchArtifactIndexResult,
  WorkbenchArtifactReadResult,
} from '../../shared/types'

// -----------------------------------------------------------------------------
// Instances
// -----------------------------------------------------------------------------

/** All workbench instances in the active workspace. */
export const workbenchInstancesAtom = atom<WorkbenchInstanceV1[]>([])

/** Currently selected workbench instance id (drives the whole page). */
export const selectedWorkbenchIdAtom = atom<string | null>(null)

/** Derived: the selected instance object (or null). */
export const selectedWorkbenchAtom = atom<WorkbenchInstanceV1 | null>((get) => {
  const id = get(selectedWorkbenchIdAtom)
  if (!id) return null
  return get(workbenchInstancesAtom).find((w) => w.id === id) ?? null
})

// -----------------------------------------------------------------------------
// Artifacts (per selected instance — refetched on index)
// -----------------------------------------------------------------------------

/** Result of the most recent artifact index for the selected instance. */
export const workbenchArtifactsAtom = atom<WorkbenchArtifactIndexResult | null>(null)

/** Currently selected artifact uri (absolute path). */
export const selectedArtifactUriAtom = atom<string | null>(null)

/** Read result (content + version) for the selected artifact. */
export const selectedArtifactReadAtom = atom<WorkbenchArtifactReadResult | null>(null)

// -----------------------------------------------------------------------------
// Threads (for the selected instance — all artifacts, filtered client-side)
// -----------------------------------------------------------------------------

/** All threads for the selected instance. */
export const workbenchThreadsAtom = atom<ReviewThreadV1[]>([])
