/**
 * Test preload: give the shared test suite a throwaway config dir.
 *
 * Why this exists — two failure modes it removes:
 *
 *  1. **Ambient-state dependence.** `loadConfigDefaults()` throws when
 *     `config-defaults.json` is missing (a deliberate startup invariant: the
 *     app must call `ensureConfigDir()` first). A dev machine that has run the
 *     app has the file; a fresh CI runner does not. Tests that transitively
 *     reach it (`getBrowserToolEnabled()` -> `getCraftAssistantPrompt()`)
 *     therefore passed locally and failed on CI for reasons unrelated to the
 *     code under test.
 *
 *  2. **Clobbering the developer's real config.** Tests that toggle flags like
 *     `extendedPromptCache` were writing to the actual config dir and relying
 *     on save/restore to put it back — a crash mid-test left the real config
 *     mutated.
 *
 * `CRAFT_CONFIG_DIR` is the documented override (see `config/paths.ts`) and is
 * resolved at module-eval, so it MUST be set before anything imports
 * `config/paths.ts`. A preload is the only hook early enough — hence bunfig's
 * `[test] preload` rather than a `beforeAll` in individual test files.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Respect an explicit override (multi-instance dev, or a suite that has already
// pointed at its own dir) — only synthesize a fixture when nothing is set.
if (!process.env.CRAFT_CONFIG_DIR) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'vorno-test-config-'));

  // Prefer the bundled asset so the fixture tracks the real shipped defaults;
  // fall back to a minimal literal if the Electron resources aren't present
  // (e.g. a shallow checkout that only built packages/).
  const bundled = resolve(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json');
  const defaults = existsSync(bundled)
    ? readFileSync(bundled, 'utf-8')
    : JSON.stringify(
        {
          version: '1.0',
          description: 'Default configuration values for Vorno (test fixture)',
          defaults: {
            notificationsEnabled: true,
            colorTheme: 'default',
            autoCapitalisation: true,
            sendMessageKey: 'enter',
            spellCheck: false,
            keepAwakeWhileRunning: false,
            richToolDescriptions: true,
            extendedPromptCache: false,
            keepBackgroundAgentsAlive: true,
            logLevel: 'info',
            browserToolEnabled: true,
            allowRemoteEvaluate: true,
          },
          workspaceDefaults: {
            thinkingLevel: 'medium',
            permissionMode: 'ask',
            cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
            localMcpServers: { enabled: true },
          },
        },
        null,
        2
      );

  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'config-defaults.json'), defaults, 'utf-8');
  // Empty config.json — tests that need specific flags write their own via the
  // exported CONFIG_FILE constant, which now resolves inside this fixture.
  writeFileSync(join(fixtureDir, 'config.json'), '{}', 'utf-8');

  process.env.CRAFT_CONFIG_DIR = fixtureDir;

  process.on('exit', () => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — the OS reaps tmpdir anyway */
    }
  });
}
