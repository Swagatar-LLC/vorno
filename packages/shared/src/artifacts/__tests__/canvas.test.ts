import { describe, it, expect } from 'bun:test';
import { parseJsonCanvas, emitJsonCanvas, type JsonCanvas } from '../canvas.ts';

function ok(content: string): JsonCanvas {
  const r = parseJsonCanvas(content);
  if ('error' in r) throw new Error(`expected ok, got: ${r.error}`);
  return r.canvas;
}

describe('parseJsonCanvas', () => {
  it('parses an empty canvas', () => {
    expect(ok('{}')).toEqual({});
  });

  it('parses each node type', () => {
    const canvas = ok(
      JSON.stringify({
        nodes: [
          { id: 't', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' },
          { id: 'f', type: 'file', x: 0, y: 0, width: 100, height: 50, file: 'note.md' },
          { id: 'l', type: 'link', x: 0, y: 0, width: 100, height: 50, url: 'https://x.dev' },
          { id: 'g', type: 'group', x: 0, y: 0, width: 200, height: 200 },
        ],
        edges: [{ id: 'e1', fromNode: 't', toNode: 'f', label: 'rel' }],
      }),
    );
    expect(canvas.nodes).toHaveLength(4);
    expect(canvas.edges).toHaveLength(1);
  });

  it('tolerates unknown extra fields (open spec)', () => {
    const canvas = ok(
      JSON.stringify({
        nodes: [{ id: 'a', type: 'group', x: 0, y: 0, width: 1, height: 1, color: '4', custom: 42 }],
        metadata: { theme: 'dark' },
      }),
    );
    expect((canvas.nodes![0] as Record<string, unknown>).custom).toBe(42);
  });

  const bad: Array<[string, string]> = [
    ['non-object', '[]'],
    ['invalid JSON', '{ not json'],
    ['nodes not array', '{"nodes": {}}'],
    ['edges not array', '{"edges": 3}'],
    ['node missing id', '{"nodes":[{"type":"text","x":0,"y":0,"width":1,"height":1,"text":"x"}]}'],
    ['node bad type', '{"nodes":[{"id":"a","type":"widget","x":0,"y":0,"width":1,"height":1}]}'],
    ['node missing coord', '{"nodes":[{"id":"a","type":"group","x":0,"y":0,"width":1}]}'],
    ['text node missing text', '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}]}'],
    ['file node missing file', '{"nodes":[{"id":"a","type":"file","x":0,"y":0,"width":1,"height":1}]}'],
    ['link node missing url', '{"nodes":[{"id":"a","type":"link","x":0,"y":0,"width":1,"height":1}]}'],
    ['edge missing fromNode', '{"edges":[{"id":"e","toNode":"b"}]}'],
    ['edge missing id', '{"edges":[{"fromNode":"a","toNode":"b"}]}'],
  ];
  for (const [label, content] of bad) {
    it(`rejects: ${label}`, () => {
      const r = parseJsonCanvas(content);
      expect('error' in r).toBe(true);
    });
  }
});

describe('emitJsonCanvas', () => {
  it('emits stable 2-space JSON that round-trips', () => {
    const canvas: JsonCanvas = {
      nodes: [{ id: 'a', type: 'text', x: 1, y: 2, width: 3, height: 4, text: 'hi' }],
    };
    const emitted = emitJsonCanvas(canvas);
    expect(emitted).toContain('\n  ');
    expect(ok(emitted)).toEqual(canvas);
  });
});
