/**
 * Workbench types — dynamic workspace surfaces (ADR-0014, PLAN-024).
 *
 * A "workbench" is an interactive surface over workspace data. The first
 * type is 'review': reading dense artifacts (governance corpus + session
 * outputs), commenting inline, and running an anchored question loop with
 * agent sessions.
 *
 * Persistence contract (agent-minable by design — plain JSON, Read/Grep):
 *   {workspaceRoot}/reviews/<workbenchId>/workbench.json   WorkbenchInstanceV1
 *   {workspaceRoot}/reviews/<workbenchId>/threads/<id>.json ReviewThreadV1
 *
 * Schema evolution follows the additive-only discipline of ADR-0013 §4a:
 * add fields (readers ignore unknowns) or bump schemaVersion; never
 * repurpose or remove a field.
 */

import type { AnnotationV1 } from './message.ts';

/** The version of an artifact a thread was anchored against. */
export interface ArtifactVersion {
  /** SHA-256 hex of the artifact file content at anchor time. */
  contentHash: string;
  /** For git-tracked artifacts: the repo HEAD SHA at anchor time. */
  gitSha?: string;
}

export type WorkbenchArtifactKind = 'corpus' | 'session-plan' | 'session-data';

/** An artifact the workbench can display. v0.1: a local markdown file. */
export interface ArtifactRef {
  /** Absolute file path (doubles as the stable artifact URI in v0.1). */
  uri: string;
  kind: WorkbenchArtifactKind;
  /** First markdown heading, falling back to the filename. */
  title: string;
  /** Present for kind 'session-plan' / 'session-data'. */
  sessionId?: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** A link between a review thread and an agent session (both directions). */
export interface WorkbenchSessionLink {
  sessionId: string;
  /** question: thread was routed into this session; origin: session produced the artifact; reference: related. */
  role: 'question' | 'origin' | 'reference';
  note?: string;
  createdAt: number;
}

export type ReviewThreadKind = 'comment' | 'question' | 'decision';
export type ReviewThreadStatus = 'open' | 'answered' | 'resolved' | 'decided';

/** One review thread: an anchored annotation plus its lifecycle and session links. */
export interface ReviewThreadV1 {
  schemaVersion: 1;
  id: string;
  workbenchId: string;
  artifactUri: string;
  artifactVersion: ArtifactVersion;
  /** Anchor (quote target) + body reuse the existing annotation model. */
  annotation: AnnotationV1;
  kind: ReviewThreadKind;
  status: ReviewThreadStatus;
  sessionLinks: WorkbenchSessionLink[];
  createdAt: number;
  updatedAt: number;
}

export type WorkbenchType = 'review';

/** A workbench instance ("review set"): a titled collection of artifacts under review. */
export interface WorkbenchInstanceV1 {
  schemaVersion: 1;
  id: string;
  type: WorkbenchType;
  title: string;
  /** Absolute directories scanned for corpus artifacts (e.g. a repo's roadmap/). */
  corpusRoots: string[];
  /** Explicitly pinned artifacts (absolute paths), shown even if outside corpusRoots. */
  artifactUris: string[];
  /** Default target session for routed questions. */
  boundSessionId?: string;
  createdAt: number;
  updatedAt: number;
}
