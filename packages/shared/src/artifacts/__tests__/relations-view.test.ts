import { describe, it, expect } from 'bun:test';
import { describeRelationEdges } from '../relations-view.ts';
import type { ArtifactRelation } from '@craft-agent/core/types';

const A = 'vorno-artifact://workspace/sessions/s1/plans/a.md';
const B = 'vorno-artifact://workspace/sessions/s1/plans/b.md';
const GONE = 'vorno-artifact://roadmap/decisions/adr.md'; // not in the index

function rel(id: string, from: string, to: string, kind = 'references'): ArtifactRelation {
  return { id, from, to, kind, createdAt: 1 };
}

const INDEX = [
  { uri: A, title: 'Plan A' },
  { uri: B, title: 'Plan B' },
];

// The unresolvable-edge badge path (G2b review item 4): an edge whose other
// end is not in the index must surface resolved:false — never be dropped.
describe('describeRelationEdges', () => {
  it('resolves the other end against the index (both directions)', () => {
    const edges = describeRelationEdges([rel('r1', A, B), rel('r2', B, A)], A, INDEX);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ otherUri: B, otherTitle: 'Plan B', resolved: true });
    expect(edges[1]).toMatchObject({ otherUri: B, otherTitle: 'Plan B', resolved: true });
  });

  it('marks an edge unresolvable when the other end is not indexed — and keeps it', () => {
    const edges = describeRelationEdges([rel('r1', A, GONE)], A, INDEX);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ otherUri: GONE, otherTitle: GONE, resolved: false });
  });

  it('a mutation that claims every edge resolvable is detected', () => {
    // Empty index ⇒ nothing is resolvable, even edges between known-shaped URIs.
    const edges = describeRelationEdges([rel('r1', A, B), rel('r2', A, GONE)], A, []);
    expect(edges.every((e) => e.resolved === false)).toBe(true);
  });

  it('self-edge (from === to) resolves to the artifact itself', () => {
    const edges = describeRelationEdges([rel('r1', A, A)], A, INDEX);
    expect(edges[0]).toMatchObject({ otherUri: A, otherTitle: 'Plan A', resolved: true });
  });

  it('never throws or drops edges on unknown kinds or foreign URIs', () => {
    const weird = [rel('r1', 'not-a-uri', 'also-not', 'acme:custom-kind')];
    const edges = describeRelationEdges(weird, A, INDEX);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolved).toBe(false);
  });
});
