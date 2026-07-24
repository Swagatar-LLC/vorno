/**
 * Pure relation-edge display resolution (PLAN-025 C1).
 *
 * Browser-safe (no fs) — deep-imported by the renderer via
 * `@craft-agent/shared/artifacts/relations-view`, unit-tested in shared. An
 * edge whose other end is not in the index resolves to `resolved: false` and
 * renders as an "unresolvable" badge — never dropped, never a crash
 * (ADR-0016: unresolvable is surfaced, same discipline as the stale badge).
 */

import type { ArtifactRelation } from '@craft-agent/core/types';

export interface RelationEdgeView {
  relation: ArtifactRelation;
  /** The endpoint that is not the selected artifact (from === to ⇒ itself). */
  otherUri: string;
  /** Index title when resolvable; the raw URI otherwise. */
  otherTitle: string;
  /** False when the other end is not present in the supplied index entries. */
  resolved: boolean;
}

/**
 * Resolve each relation touching `selectedUri` against the current index
 * entries for display.
 */
export function describeRelationEdges(
  relations: ArtifactRelation[],
  selectedUri: string,
  entries: ReadonlyArray<{ uri: string; title: string }>,
): RelationEdgeView[] {
  return relations.map((relation) => {
    const otherUri = relation.from === selectedUri ? relation.to : relation.from;
    const found = entries.find((e) => e.uri === otherUri);
    return found
      ? { relation, otherUri, otherTitle: found.title, resolved: true }
      : { relation, otherUri, otherTitle: otherUri, resolved: false };
  });
}
