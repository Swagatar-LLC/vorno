/**
 * Tests for AutomationSystem facade
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationSystem, __resetMissedFireGuardForTests, type SessionMetadataSnapshot } from './automation-system.ts';
import { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE } from './constants.ts';
import { readFileSync, existsSync } from 'node:fs';

/** Poll the history file until `predicate` holds or the timeout elapses. */
async function waitForHistory(
  dir: string,
  predicate: (entries: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 2000,
): Promise<Array<Record<string, unknown>>> {
  const path = join(dir, AUTOMATIONS_HISTORY_FILE);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries: Array<Record<string, unknown>> = [];
    if (existsSync(path)) {
      entries = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    }
    if (predicate(entries)) return entries;
    if (Date.now() > deadline) return entries;
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('AutomationSystem', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'automation-system-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create an AutomationSystem without automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.isDisposed()).toBe(false);
      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    it('should load automations.json if present', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const config = system.getConfig();
      expect(config?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should handle invalid automations.json gracefully', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), 'invalid json');

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });

    it('should preserve thinkingLevel on prompt actions through load', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'review',
              actions: [{
                type: 'prompt',
                prompt: 'Audit changes',
                llmConnection: 'anthropic',
                model: 'claude-opus-4-7',
                thinkingLevel: 'high',
              }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const config = system.getConfig();
      const action = config?.automations.LabelAdd?.[0]?.actions[0];
      expect(action).toMatchObject({
        type: 'prompt',
        thinkingLevel: 'high',
      });

      await system.dispose();
    });

    it('should reject semantically invalid conditions at load time', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', after: '25:99' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      await system.dispose();
    });
  });

  describe('reloadConfig', () => {
    it('should reload automations.json', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      expect(system.getConfig()).toEqual({ automations: {} });

      // Create automations.json
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              matcher: 'test',
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true);
      expect(result.automationCount).toBe(1);
      expect(system.getConfig()?.automations.LabelAdd).toHaveLength(1);

      await system.dispose();
    });

    it('should return errors for invalid config', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Invalid JSON structure (actions must have at least one action)
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test', actions: 'not-an-array' }, // Invalid: actions should be an array
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      await system.dispose();
    });

    it('should return errors for semantically invalid conditions', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            {
              conditions: [{ condition: 'time', before: '99:00' }],
              actions: [{ type: 'prompt', prompt: 'echo hello' }],
            },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid time value'))).toBe(true);

      await system.dispose();
    });

    it('should ignore unknown event types with warning', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Unknown events are filtered out with a warning, not an error
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          UnknownEvent: [
            { matcher: 'test', actions: [{ type: 'prompt', prompt: 'echo test' }] },
          ],
        },
      }));

      const result = system.reloadConfig();
      expect(result.success).toBe(true); // Unknown events are ignored, not errors
      expect(result.automationCount).toBe(0); // No valid actions

      await system.dispose();
    });
  });

  describe('getMatchersForEvent', () => {
    it('should return matchers for configured events', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          LabelAdd: [
            { matcher: 'test1', actions: [{ type: 'prompt', prompt: 'echo 1' }] },
            { matcher: 'test2', actions: [{ type: 'prompt', prompt: 'echo 2' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toHaveLength(2);
      expect(matchers[0]?.matcher).toBe('test1');

      await system.dispose();
    });

    it('should return empty array for unconfigured events', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matchers = system.getMatchersForEvent('LabelAdd');
      expect(matchers).toEqual([]);

      await system.dispose();
    });
  });

  describe('updateSessionMetadata', () => {
    it('should emit PermissionModeChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
      });

      expect(events).toContain('PermissionModeChange');
      expect(emitSpy).toHaveBeenCalledWith('PermissionModeChange', expect.objectContaining({
        sessionId: 'session-1',
        oldMode: '',
        newMode: 'execute',
      }));

      await system.dispose();
    });

    it('should emit LabelAdd event for new labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      expect(events).toContain('LabelAdd');
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-1',
      }));
      expect(emitSpy).toHaveBeenCalledWith('LabelAdd', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit LabelRemove event for removed labels', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      // Set initial state
      system.setInitialSessionMetadata('session-1', {
        labels: ['label-1', 'label-2'],
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        labels: ['label-1'], // label-2 removed
      });

      expect(events).toContain('LabelRemove');
      expect(emitSpy).toHaveBeenCalledWith('LabelRemove', expect.objectContaining({
        label: 'label-2',
      }));

      await system.dispose();
    });

    it('should emit FlagChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        isFlagged: true,
      });

      expect(events).toContain('FlagChange');
      expect(emitSpy).toHaveBeenCalledWith('FlagChange', expect.objectContaining({
        isFlagged: true,
      }));

      await system.dispose();
    });

    it('should emit SessionStatusChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        sessionStatus: 'todo',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        sessionStatus: 'done',
      });

      expect(events).toContain('SessionStatusChange');
      expect(emitSpy).toHaveBeenCalledWith('SessionStatusChange', expect.objectContaining({
        oldState: 'todo',
        newState: 'done',
      }));

      await system.dispose();
    });

    it('should not emit events when metadata unchanged', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      const events = await system.updateSessionMetadata('session-1', {
        permissionMode: 'explore',
        labels: ['label-1'],
        isFlagged: false,
      });

      expect(events).toEqual([]);
      expect(emitSpy).not.toHaveBeenCalled();

      await system.dispose();
    });

    it('should update stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.updateSessionMetadata('session-1', {
        permissionMode: 'execute',
        labels: ['label-1'],
      });

      const stored = system.getSessionMetadata('session-1');
      expect(stored?.permissionMode).toBe('execute');
      expect(stored?.labels).toEqual(['label-1']);

      await system.dispose();
    });

    // ADR-0021 §3 (amended): the mutation sites call updateSessionMetadata directly, and the
    // fs-watch echo of that same write arrives later carrying an identical snapshot. The echo
    // must be a no-op — that property is what makes dual emit paths safe without correlation.
    it('should treat a repeat call with an identical snapshot as a no-op (fs-watch echo)', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const snapshot: SessionMetadataSnapshot = {
        permissionMode: 'execute',
        labels: ['label-1', 'label-2'],
        sessionStatus: 'in-progress',
      };

      const first = await system.updateSessionMetadata('session-1', snapshot);
      expect(first.length).toBeGreaterThan(0);

      const emitSpy = spyOn(system.eventBus, 'emit');
      const echo = await system.updateSessionMetadata('session-1', { ...snapshot });

      expect(echo).toEqual([]);
      expect(emitSpy).not.toHaveBeenCalled();

      await system.dispose();
    });

    // With two caller classes (direct + watcher-for-external-writes) the body's
    // read-modify-write around an awaited emit could interleave: both calls read the same
    // `prev` and double-emit the same diff. Serialization makes the second call wait and
    // observe the first call's stored snapshot. A slow subscribed handler holds the first
    // call mid-emit to force the overlap deterministically.
    it('should serialize overlapping calls per session (no double-emit)', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      let releaseHandler: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseHandler = resolve; });
      let labelAddCount = 0;
      system.eventBus.on('LabelAdd', async () => {
        labelAddCount++;
        await gate;
      });

      const snapshot: SessionMetadataSnapshot = { labels: ['label-1'] };
      const first = system.updateSessionMetadata('session-1', snapshot);
      const second = system.updateSessionMetadata('session-1', { ...snapshot });

      // Let the first call reach its awaited emit before releasing it.
      await new Promise((r) => setTimeout(r, 10));
      releaseHandler();

      const [firstEvents, secondEvents] = await Promise.all([first, second]);
      expect(firstEvents).toContain('LabelAdd');
      expect(secondEvents).toEqual([]);
      expect(labelAddCount).toBe(1);

      await system.dispose();
    });

    it('should not serialize across different sessions', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      let releaseHandler: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseHandler = resolve; });
      system.eventBus.on('LabelAdd', async (payload) => {
        if (payload.sessionId === 'session-slow') await gate;
      });

      const slow = system.updateSessionMetadata('session-slow', { labels: ['label-1'] });
      // A different session must not queue behind session-slow's in-flight emit.
      const fastEvents = await system.updateSessionMetadata('session-fast', { labels: ['label-2'] });
      expect(fastEvents).toContain('LabelAdd');

      releaseHandler();
      expect(await slow).toContain('LabelAdd');

      await system.dispose();
    });
  });

  describe('removeSessionMetadata', () => {
    it('should remove stored metadata', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', {
        permissionMode: 'explore',
      });

      expect(system.getSessionMetadata('session-1')).toBeDefined();

      system.removeSessionMetadata('session-1');

      expect(system.getSessionMetadata('session-1')).toBeUndefined();

      await system.dispose();
    });
  });

  describe('emitLabelConfigChange', () => {
    it('should emit LabelConfigChange event', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const emitSpy = spyOn(system.eventBus, 'emit');

      await system.emitLabelConfigChange();

      expect(emitSpy).toHaveBeenCalledWith('LabelConfigChange', expect.objectContaining({
        workspaceId: 'test-workspace',
      }));

      await system.dispose();
    });
  });

  describe('executeAgentEvent', () => {
    it('should match agent events when matcher and conditions pass', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PreToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(1);
      await system.dispose();
    });

    it('should not match agent events when conditions fail', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            {
              matcher: '^Bash$',
              conditions: [{ condition: 'state', field: 'hook_event_name', value: 'PostToolUse' }],
              actions: [{ type: 'prompt', prompt: 'check this' }],
            },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const matched = await system.executeAgentEvent('PreToolUse', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      });

      expect(matched).toBe(0);
      await system.dispose();
    });
  });

  describe('buildSdkHooks', () => {
    it('should return empty object (command execution removed)', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
        automations: {
          PreToolUse: [
            { matcher: 'Bash', actions: [{ type: 'prompt', prompt: 'check this' }] },
          ],
        },
      }));

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      const result = system.buildSdkHooks();
      expect(result).toEqual({});

      await system.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      system.setInitialSessionMetadata('session-1', { permissionMode: 'explore' });

      await system.dispose();

      expect(system.isDisposed()).toBe(true);
      expect(system.eventBus.isDisposed()).toBe(true);
      expect(system.getSessionMetadata('session-1')).toBeUndefined();
    });

    it('should be idempotent', async () => {
      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
      });

      await system.dispose();
      await system.dispose(); // Should not throw
      expect(system.isDisposed()).toBe(true);
    });
  });

  // fork(PLAN-017): missed-fire detection on scheduler startup
  describe('missed-fire detection', () => {
    beforeEach(() => {
      __resetMissedFireGuardForTests();
    });

    /** A daily 09:00 UTC matcher whose most recent fire (yesterday/today) is
     * within the 24h lookback — with no history it is always "missed". */
    function dailyConfig() {
      return JSON.stringify({
        automations: {
          SchedulerTick: [
            { id: 'sched1', cron: '0 9 * * *', timezone: 'UTC', actions: [{ type: 'prompt', prompt: 'daily' }] },
          ],
        },
      });
    }

    it('appends exactly one missed record on scheduler startup', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), dailyConfig());

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        enableScheduler: true,
      });

      const entries = await waitForHistory(tempDir, es => es.some(e => e.kind === 'missed'));
      const missed = entries.filter(e => e.kind === 'missed');
      expect(missed).toHaveLength(1);
      expect(missed[0]!.id).toBe('sched1');
      expect(missed[0]!.ok).toBe(false);
      expect(typeof missed[0]!.expectedTs).toBe('number');

      await system.dispose();
    });

    it('runs detection at most once per process per workspace (guard)', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), dailyConfig());

      const system1 = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        enableScheduler: true,
      });
      await waitForHistory(tempDir, es => es.some(e => e.kind === 'missed'));
      await system1.dispose();

      // A second system for the SAME workspace must NOT append another missed
      // record (guard is set; also the existing missed record dedups it).
      const system2 = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        enableScheduler: true,
      });
      // Give detection a chance to (not) run.
      await new Promise(r => setTimeout(r, 200));

      const entries = existsSync(join(tempDir, AUTOMATIONS_HISTORY_FILE))
        ? readFileSync(join(tempDir, AUTOMATIONS_HISTORY_FILE), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];
      expect(entries.filter(e => e.kind === 'missed')).toHaveLength(1);

      await system2.dispose();
    });

    it('does not append missed records when the scheduler is disabled', async () => {
      writeFileSync(join(tempDir, AUTOMATIONS_CONFIG_FILE), dailyConfig());

      const system = new AutomationSystem({
        workspaceRootPath: tempDir,
        workspaceId: 'test-workspace',
        // enableScheduler omitted → detection never runs
      });
      await new Promise(r => setTimeout(r, 150));

      const path = join(tempDir, AUTOMATIONS_HISTORY_FILE);
      const entries = existsSync(path)
        ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];
      expect(entries.filter(e => e.kind === 'missed')).toHaveLength(0);

      await system.dispose();
    });
  });
});
