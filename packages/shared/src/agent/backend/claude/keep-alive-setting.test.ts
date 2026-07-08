import { describe, it, expect } from 'bun:test';
import {
  getKeepBackgroundTasksAliveState,
  isKeepBackgroundTasksAliveEnabled,
} from './keep-alive-setting.ts';

describe('getKeepBackgroundTasksAliveState', () => {
  it('is ON by default when env unset and nothing stored (upstream default)', () => {
    expect(getKeepBackgroundTasksAliveState({}, () => true)).toEqual({
      enabled: true,
      envOverride: false,
    });
  });

  it('honors a stored toggle-off when env is unset', () => {
    expect(getKeepBackgroundTasksAliveState({}, () => false)).toEqual({
      enabled: false,
      envOverride: false,
    });
  });

  it('lets env "0"/"false" beat a stored true (explicit kill-switch)', () => {
    expect(getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: '0' }, () => true)).toEqual({
      enabled: false,
      envOverride: true,
    });
    expect(
      getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: 'false' }, () => true),
    ).toEqual({ enabled: false, envOverride: true });
  });

  it('lets env "1"/"true" beat a stored false', () => {
    expect(getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: '1' }, () => false)).toEqual({
      enabled: true,
      envOverride: true,
    });
    expect(
      getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: 'true' }, () => false),
    ).toEqual({ enabled: true, envOverride: true });
  });

  it('sets envOverride true only when the env var is present', () => {
    expect(getKeepBackgroundTasksAliveState({}, () => true).envOverride).toBe(false);
    expect(
      getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: '1' }, () => true).envOverride,
    ).toBe(true);
  });

  it('ignores unrecognized env values and falls back to stored', () => {
    expect(
      getKeepBackgroundTasksAliveState({ CRAFT_KEEP_BG_AGENTS_ALIVE: 'yes' }, () => false),
    ).toEqual({ enabled: false, envOverride: false });
  });
});

describe('isKeepBackgroundTasksAliveEnabled', () => {
  it('returns the effective enabled boolean', () => {
    // Default path reads real storage; assert it returns a boolean without throwing.
    expect(typeof isKeepBackgroundTasksAliveEnabled()).toBe('boolean');
  });
});
