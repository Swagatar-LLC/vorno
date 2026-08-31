/**
 * TypeScript types for config-defaults.json
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 * This file only defines types - the actual defaults come from the bundled JSON.
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

export interface ConfigDefaults {
  version: string;
  description: string;
  defaults: {
    notificationsEnabled: boolean;
    colorTheme: string;
    autoCapitalisation: boolean;
    sendMessageKey: 'enter' | 'cmd-enter';
    spellCheck: boolean;
    keepAwakeWhileRunning: boolean;
    richToolDescriptions: boolean;
    extendedPromptCache: boolean;
    keepBackgroundAgentsAlive: boolean;  // fork(PLAN-011)
    logLevel: 'error' | 'warn' | 'info' | 'debug';  // fork(PLAN-015): production file-log level
    browserToolEnabled: boolean;
    /**
     * Allow remote agents to call `browser_tool evaluate <expression>`.
     * When false, the local dispatcher rejects with `BROWSER_REMOTE_EVALUATE_BLOCKED`.
     */
    allowRemoteEvaluate: boolean;
  };
  workspaceDefaults: {
    thinkingLevel: ThinkingLevel;
    permissionMode: PermissionMode;
    cyclablePermissionModes: PermissionMode[];
    /**
     * Minutes an idle session keeps its warm agent runtime before
     * SessionManager disposes it (PLAN-038). 0 disables eviction.
     */
    idleAgentTtlMinutes: number;  // fork(PLAN-038)
    /**
     * Minutes a hidden, unbound, session-created browser window survives
     * before the idle reaper destroys it. 0 disables reaping.
     */
    idleBrowserTtlMinutes: number;  // fork(PLAN-047, SUV-0044)
    localMcpServers: {
      enabled: boolean;
    };
  };
}
