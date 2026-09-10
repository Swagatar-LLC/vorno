#!/usr/bin/env bun
/**
 * Install the standalone vorno-cli binary for the current platform.
 *
 * `VORNO_CLI_INSTALL_DIR` is an explicit, shell-independent destination for
 * automation and non-standard PATH layouts. Without it, POSIX installs to
 * ~/.local/bin and Windows installs to %LOCALAPPDATA%\Vorno\bin.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const explicitDir = process.env.VORNO_CLI_INSTALL_DIR?.trim();
const outdir = explicitDir
  ? resolve(explicitDir)
  : process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Vorno', 'bin')
    : join(homedir(), '.local', 'bin');
const binName = process.platform === 'win32' ? 'vorno-cli.exe' : 'vorno-cli';
const outfile = join(outdir, binName);

mkdirSync(outdir, { recursive: true });

const build = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'build-cli.ts'), `--outdir=${outdir}`, '--name=vorno-cli'],
  { cwd: ROOT, stdio: 'inherit' },
);

if (build.status !== 0 || !existsSync(outfile)) {
  process.exit(build.status ?? 1);
}

const pathEntries = (process.env.PATH || '')
  .split(delimiter)
  .filter(Boolean)
  .map((entry) => resolve(entry));
const installOnPath = pathEntries.some((entry) =>
  process.platform === 'win32'
    ? entry.toLowerCase() === outdir.toLowerCase()
    : entry === outdir,
);

console.log(`✓ vorno-cli installed at ${outfile}`);
if (!installOnPath) {
  if (process.platform === 'win32') {
    console.log(`Add ${outdir} to your user PATH, then open a new terminal.`);
  } else {
    console.log(`Add ${outdir} to PATH if it is not already present, then open a new shell.`);
  }
}
