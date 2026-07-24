/**
 * JSON Canvas v1.0 parse/emit (jsoncanvas.org; ADR-0016 built-in type
 * `json-canvas`).
 *
 * Minimal-spec validation: `nodes` and `edges` are optional arrays; each node
 * needs an id, a type in {text,file,link,group}, and integer-ish x/y/width/
 * height plus its type-specific payload (text/file/url). Each edge needs an id,
 * fromNode, and toNode. The spec is open, so unknown extra fields are tolerated
 * and preserved. Types are kept local to shared; the renderer consumes them via
 * its own leg.
 */

export type JsonCanvasNodeType = 'text' | 'file' | 'link' | 'group';

export interface JsonCanvasNode {
  id: string;
  type: JsonCanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  // Type-specific (one of, by type):
  text?: string;
  file?: string;
  url?: string;
  // Open spec — unknown fields preserved.
  [key: string]: unknown;
}

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  fromEnd?: string;
  toEnd?: string;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface JsonCanvas {
  nodes?: JsonCanvasNode[];
  edges?: JsonCanvasEdge[];
  [key: string]: unknown;
}

const NODE_TYPES = new Set<string>(['text', 'file', 'link', 'group']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateNode(node: unknown, i: number): string | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return `nodes[${i}] must be an object`;
  }
  const n = node as Record<string, unknown>;
  if (!isNonEmptyString(n.id)) return `nodes[${i}] missing string id`;
  if (typeof n.type !== 'string' || !NODE_TYPES.has(n.type)) {
    return `nodes[${i}] has invalid type (must be text|file|link|group)`;
  }
  for (const coord of ['x', 'y', 'width', 'height'] as const) {
    if (!isFiniteNumber(n[coord])) return `nodes[${i}] missing numeric ${coord}`;
  }
  switch (n.type) {
    case 'text':
      if (typeof n.text !== 'string') return `nodes[${i}] (text) missing text`;
      break;
    case 'file':
      if (!isNonEmptyString(n.file)) return `nodes[${i}] (file) missing file`;
      break;
    case 'link':
      if (!isNonEmptyString(n.url)) return `nodes[${i}] (link) missing url`;
      break;
    // 'group' has no required type-specific payload.
  }
  return null;
}

function validateEdge(edge: unknown, i: number): string | null {
  if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
    return `edges[${i}] must be an object`;
  }
  const e = edge as Record<string, unknown>;
  if (!isNonEmptyString(e.id)) return `edges[${i}] missing string id`;
  if (!isNonEmptyString(e.fromNode)) return `edges[${i}] missing fromNode`;
  if (!isNonEmptyString(e.toNode)) return `edges[${i}] missing toNode`;
  return null;
}

/**
 * Parse + validate a JSON Canvas document. Returns `{ canvas }` on success or
 * `{ error }` with a specific message. Never throws.
 */
export function parseJsonCanvas(content: string): { canvas: JsonCanvas } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'canvas must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.nodes !== undefined) {
    if (!Array.isArray(obj.nodes)) return { error: 'nodes must be an array' };
    for (let i = 0; i < obj.nodes.length; i++) {
      const err = validateNode(obj.nodes[i], i);
      if (err) return { error: err };
    }
  }
  if (obj.edges !== undefined) {
    if (!Array.isArray(obj.edges)) return { error: 'edges must be an array' };
    for (let i = 0; i < obj.edges.length; i++) {
      const err = validateEdge(obj.edges[i], i);
      if (err) return { error: err };
    }
  }

  return { canvas: obj as JsonCanvas };
}

/** Emit a JSON Canvas document as stable 2-space JSON. */
export function emitJsonCanvas(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, 2);
}
