import { describe, expect, it } from 'bun:test';
import { compareSemver, getReleaseNotesList, isReleaseNoteFilename } from './index.ts';

describe('release notes loader', () => {
  it('treats only X.Y.Z.md files as release notes', () => {
    expect(isReleaseNoteFilename('0.13.1.md')).toBe(true);
    expect(isReleaseNoteFilename('10.0.12.md')).toBe(true);
    // next.md is the pending-notes template that ships alongside the versioned files.
    expect(isReleaseNoteFilename('next.md')).toBe(false);
    expect(isReleaseNoteFilename('README.md')).toBe(false);
    expect(isReleaseNoteFilename('0.13.md')).toBe(false);
    expect(isReleaseNoteFilename('0.13.1.md.bak')).toBe(false);
    expect(isReleaseNoteFilename('v0.13.1.md')).toBe(false);
  });

  it('accepts SemVer prerelease filenames but rejects build metadata and non-versioned names', () => {
    expect(isReleaseNoteFilename('0.22.0-beta.1.md')).toBe(true);
    expect(isReleaseNoteFilename('1.0.0-rc.2.md')).toBe(true);
    expect(isReleaseNoteFilename('1.0.0-alpha.md')).toBe(true);
    // build metadata is not a filename we ever ship; keep it rejected.
    expect(isReleaseNoteFilename('1.0.0+build.5.md')).toBe(false);
    expect(isReleaseNoteFilename('1.0.0-beta.1+build.5.md')).toBe(false);
    expect(isReleaseNoteFilename('next.md')).toBe(false);
    expect(isReleaseNoteFilename('foo.md')).toBe(false);
  });

  it('sorts stable releases ahead of their prereleases, newest first', () => {
    const versions = ['0.21.0', '0.22.0-beta.1', '0.22.0', '0.22.0-beta.2'];
    expect([...versions].sort(compareSemver)).toEqual([
      '0.22.0',
      '0.22.0-beta.2',
      '0.22.0-beta.1',
      '0.21.0',
    ]);
  });

  it('never surfaces a non-semver version in the What\'s New list', () => {
    // Resolves against whichever notes directory exists on this machine (bundled
    // resources or ~/.craft-agent/release-notes); an empty list is fine.
    for (const note of getReleaseNotesList()) {
      expect(note.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
