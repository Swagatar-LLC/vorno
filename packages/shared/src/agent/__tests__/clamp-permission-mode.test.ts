import { describe, expect, it } from 'bun:test';
import { clampPermissionMode } from '../mode-types.ts';

describe('clampPermissionMode', () => {
  it('keeps a requested mode that is as strict or stricter than the ceiling', () => {
    expect(clampPermissionMode('safe', 'ask')).toBe('safe');
    expect(clampPermissionMode('ask', 'ask')).toBe('ask');
    expect(clampPermissionMode('ask', 'allow-all')).toBe('ask');
  });

  it('lowers a looser requested mode to the ceiling', () => {
    expect(clampPermissionMode('allow-all', 'ask')).toBe('ask');
    expect(clampPermissionMode('allow-all', 'safe')).toBe('safe');
    expect(clampPermissionMode('ask', 'safe')).toBe('safe');
  });

  it('inherits the ceiling when nothing was requested', () => {
    expect(clampPermissionMode(undefined, 'ask')).toBe('ask');
  });
});
