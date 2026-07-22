import { describe, it, expect } from 'bun:test';
import {
  formatArtifactUri,
  parseArtifactUri,
  RESERVED_WORKSPACE_ROOT_ID,
  isValidRootId,
} from '../uri.ts';

describe('parseArtifactUri / formatArtifactUri', () => {
  it('round-trips valid URIs (parse ∘ format = identity)', () => {
    const cases = [
      { rootId: 'workspace', relPath: 'sessions/260721-fresh-flint/plans/design.md' },
      { rootId: 'roadmap', relPath: 'decisions/0015-two-plane.md' },
      { rootId: 'a', relPath: 'b' },
      { rootId: 'r-1', relPath: 'nested/deep/file.canvas' },
      // percent-encoding round-trip: spaces + unicode preserved through encode/decode
      { rootId: 'docs', relPath: 'a folder/Ünïcödé note.md' },
      { rootId: 'docs', relPath: 'has#hash and?query.md' },
    ];
    for (const c of cases) {
      const uri = formatArtifactUri(c);
      const parsed = parseArtifactUri(uri);
      expect(parsed).toEqual(c);
    }
  });

  it('encodes spaces/special chars and decodes them back', () => {
    const uri = formatArtifactUri({ rootId: 'docs', relPath: 'my file.md' });
    expect(uri).toBe('vorno-artifact://docs/my%20file.md');
    expect(parseArtifactUri(uri)).toEqual({ rootId: 'docs', relPath: 'my file.md' });
  });

  it('preserves case in the relPath', () => {
    const parsed = parseArtifactUri('vorno-artifact://roadmap/Decisions/ADR-0016.md');
    expect(parsed).toEqual({ rootId: 'roadmap', relPath: 'Decisions/ADR-0016.md' });
  });

  it('exposes the reserved workspace root id', () => {
    expect(RESERVED_WORKSPACE_ROOT_ID).toBe('workspace');
  });

  describe('rejection table (returns null)', () => {
    const rejected: Array<[string, string]> = [
      ['wrong scheme', 'file:///etc/passwd'],
      ['no scheme', 'workspace/a.md'],
      ['missing path portion', 'vorno-artifact://workspace'],
      ['empty relPath', 'vorno-artifact://workspace/'],
      ['dot segment', 'vorno-artifact://workspace/a/./b.md'],
      ['dotdot segment', 'vorno-artifact://workspace/a/../b.md'],
      ['leading slash oddity (empty first segment)', 'vorno-artifact://workspace//a.md'],
      ['trailing slash (empty last segment)', 'vorno-artifact://workspace/a/'],
      ['double slash mid-path', 'vorno-artifact://workspace/a//b.md'],
      ['backslash', 'vorno-artifact://workspace/a\\b.md'],
      ['uppercase rootId', 'vorno-artifact://Workspace/a.md'],
      ['rootId with space', 'vorno-artifact://work space/a.md'],
      ['rootId too long', `vorno-artifact://${'a'.repeat(65)}/a.md`],
      ['empty rootId', 'vorno-artifact:///a.md'],
      ['encoded dotdot', 'vorno-artifact://workspace/%2e%2e/secret.md'],
      ['encoded slash smuggle', 'vorno-artifact://workspace/a%2Fb.md'],
      ['malformed percent-escape', 'vorno-artifact://workspace/a%2.md'],
    ];
    for (const [label, uri] of rejected) {
      it(`rejects: ${label}`, () => {
        expect(parseArtifactUri(uri)).toBeNull();
      });
    }
  });

  it('isValidRootId matches the kebab regex', () => {
    expect(isValidRootId('workspace')).toBe(true);
    expect(isValidRootId('r-1')).toBe(true);
    expect(isValidRootId('a'.repeat(64))).toBe(true);
    expect(isValidRootId('a'.repeat(65))).toBe(false);
    expect(isValidRootId('Bad')).toBe(false);
    expect(isValidRootId('has space')).toBe(false);
    expect(isValidRootId('')).toBe(false);
  });
});
