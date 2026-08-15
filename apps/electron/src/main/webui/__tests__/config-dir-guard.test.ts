/**
 * Hermeticity guard (LEARNING-056, vorno-internal): the CONFIG_DIR this test
 * run actually resolved must live under the OS temp dir.
 *
 * If this test is red, config/paths.ts froze CONFIG_DIR before the bunfig
 * `[test]` preload claimed CRAFT_CONFIG_DIR — or the preload was removed —
 * and every config write in this run lands in a REAL config dir (on a dev
 * machine: the live app's ~/.vorno-agent, i.e. the running WebUI's password
 * store). An explicit non-tmp CRAFT_CONFIG_DIR is rejected for the same
 * reason: test runs must never target a directory that outlives them.
 * Fix the preload (apps/electron/bunfig.toml); do not weaken this assertion.
 */
import { test, expect } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { CONFIG_DIR } from '@craft-agent/shared/config/paths';

test('CONFIG_DIR resolves under os.tmpdir() (hermetic test run)', () => {
  const configReal = realpathSync(CONFIG_DIR);
  const tmpReal = realpathSync(tmpdir());
  const hermetic = configReal === tmpReal || configReal.startsWith(tmpReal + sep);
  if (!hermetic) {
    throw new Error(
      `CONFIG_DIR resolves to ${configReal}, outside os.tmpdir() (${tmpReal}) — ` +
        `this run reads/writes a REAL config dir. See LEARNING-056.`,
    );
  }
  expect(hermetic).toBe(true);
});
