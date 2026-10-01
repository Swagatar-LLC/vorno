import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run in a child so HOME changes cannot affect another test or the live app.
describe('standalone config validation root', () => {
  for (const override of [undefined, 'custom-root']) {
    it(`validates the ${override ? 'explicit' : 'Vorno default'} root, not upstream state`, () => {
      const home = mkdtempSync(join(tmpdir(), 'vorno-validate-home-'));
      try {
        const root = join(home, override ?? '.vorno-agent');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [] }));
        mkdirSync(join(home, '.craft-agent'));
        writeFileSync(join(home, '.craft-agent', 'config.json'), 'invalid json');
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
        delete env.CRAFT_CONFIG_DIR;
        if (override) env.CRAFT_CONFIG_DIR = root;
        const result = Bun.spawnSync({
          cmd: [process.execPath, '-e', `
            const { handleConfigValidate } = await import(${JSON.stringify(join(import.meta.dir, 'config-validate.ts'))});
            console.log(JSON.stringify(await handleConfigValidate({}, { target: 'config' })));
          `],
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const response = JSON.parse(result.stdout.toString());
        expect(response.isError).not.toBe(true);
        expect(response.content[0].text).toContain('Validation passed');
        expect(response.content[0].text).not.toContain('Validation failed');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
