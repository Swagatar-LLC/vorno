import { describe, it, expect } from 'bun:test';
import {
  getArtifactTypeForPath,
  getRegisteredExtensions,
  listArtifactTypes,
  isSystemTypeId,
  isValidTypeId,
  FALLBACK_TYPE_ID,
} from '../registry.ts';

describe('getArtifactTypeForPath', () => {
  it('matches built-in extensions (case-insensitive)', () => {
    expect(getArtifactTypeForPath('/x/a.md')).toBe('markdown');
    expect(getArtifactTypeForPath('/x/a.MARKDOWN')).toBe('markdown');
    expect(getArtifactTypeForPath('/x/board.canvas')).toBe('json-canvas');
    expect(getArtifactTypeForPath('/x/data.json')).toBe('json');
  });

  it('falls back to file for unknown/no extension', () => {
    expect(getArtifactTypeForPath('/x/photo.png')).toBe(FALLBACK_TYPE_ID);
    expect(getArtifactTypeForPath('/x/Makefile')).toBe(FALLBACK_TYPE_ID);
    expect(getArtifactTypeForPath('/x/README')).toBe(FALLBACK_TYPE_ID);
  });
});

describe('getRegisteredExtensions', () => {
  it('is the union of descriptor extensions (file contributes none)', () => {
    const exts = getRegisteredExtensions();
    expect(exts.has('.md')).toBe(true);
    expect(exts.has('.markdown')).toBe(true);
    expect(exts.has('.canvas')).toBe(true);
    expect(exts.has('.json')).toBe(true);
    expect(exts.has('.png')).toBe(false);
  });
});

describe('listArtifactTypes', () => {
  it('returns the built-ins including the file fallback', () => {
    const ids = listArtifactTypes().map((d) => d.id);
    expect(ids).toEqual(['markdown', 'json-canvas', 'json', 'file']);
    const md = listArtifactTypes().find((d) => d.id === 'markdown');
    expect(md?.mimeType).toBe('text/markdown');
  });

  it('returns defensive copies (mutating extensions does not leak)', () => {
    const first = listArtifactTypes()[0]!;
    first.extensions.push('.evil');
    expect(getRegisteredExtensions().has('.evil')).toBe(false);
  });
});

describe('id validation', () => {
  it('isSystemTypeId is true only for un-prefixed ids', () => {
    expect(isSystemTypeId('markdown')).toBe(true);
    expect(isSystemTypeId('acme:dataset')).toBe(false);
  });

  it('isValidTypeId accepts system built-ins and prefixed forms', () => {
    expect(isValidTypeId('markdown')).toBe(true);
    expect(isValidTypeId('json-canvas')).toBe(true);
    expect(isValidTypeId('acme:dataset')).toBe(true);
    // rejections
    expect(isValidTypeId('Bad')).toBe(false);
    expect(isValidTypeId('has space')).toBe(false);
    expect(isValidTypeId('a:b:c')).toBe(false);
    expect(isValidTypeId(':leading')).toBe(false);
    expect(isValidTypeId('trailing:')).toBe(false);
  });
});
