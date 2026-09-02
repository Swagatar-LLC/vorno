#!/usr/bin/env bun
/**
 * Build script for the standalone `vorno-cli` binary.
 *
 * fork(PLAN-049): the CLI shipped as a TypeScript entry point with no build
 * step and no install path. `apps/cli/package.json` declared
 * `"bin": {"vorno-cli": "src/index.ts"}`, which only resolves under `bun` inside
 * the workspace, so there was no way to install it — not via npm, and not from
 * the packaged app. Meanwhile `apps/electron/src/main/index.ts` pointed
 * `CRAFT_CLI_ENTRY` at `packages/craft-cli/src/cli.ts` and `CRAFT_COMMANDS_ENTRY`
 * at `packages/craft-agents-commands/src/main.ts` — two packages that no longer
 * exist in this repo. Both variables were dead in packaged AND dev builds, and
 * nothing validated them, so it rotted silently.
 *
 * `bun build --compile` produces a single self-contained executable with the Bun
 * runtime embedded. Verified to run under `env -i` (no PATH, no CRAFT_* vars, no
 * bun on the system), which is what makes "comes with the product" true rather
 * than "works if your shell happens to be set up right". It also sidesteps
 * workspace module resolution entirely — the alternative was staging
 * `packages/shared` and `packages/server-core` sources into the bundle and hoping
 * the import graph resolved at runtime.
 *
 * Usage:
 *   bun run scripts/build-cli.ts
 *   bun run scripts/build-cli.ts --target=darwin-arm64
 *   bun run scripts/build-cli.ts --outdir=apps/electron/resources/bin
 *
 * Options:
 *   --target     bun compile target (default: host). One of:
 *                darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64
 *   --outdir     Output directory (default: dist/cli)
 *   --name       Binary name (default: vorno-cli)
 *   --quiet      Only print on failure
 *   --help       Show help
 */

import { parseArgs } from 'util';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, statSync, chmodSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BUN_TARGETS: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64': 'bun-linux-x64',
  'windows-x64': 'bun-windows-x64',
};

function hostTarget(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${platform}-${arch}`;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: 'string' },
    outdir: { type: 'string' },
    name: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(
    (import.meta.dir, String.raw`
build-cli — compile vorno-cli into a standalone executable

  bun run scripts/build-cli.ts [--target=<t>] [--outdir=<dir>] [--name=<n>]

Targets: ${Object.keys(BUN_TARGETS).join(', ')}
`),
  );
  process.exit(0);
}

const target = values.target ?? hostTarget();
const bunTarget = BUN_TARGETS[target];
if (!bunTarget) {
  console.error(
    `✗ build-cli: unknown target "${target}". Known: ${Object.keys(BUN_TARGETS).join(', ')}`,
  );
  process.exit(2);
}

const entry = join(ROOT, 'apps', 'cli', 'src', 'index.ts');
if (!existsSync(entry)) {
  // A missing entry means the CLI moved again. Fail loudly and name the path,
  // because the whole reason this script exists is that a silently-wrong path
  // went unnoticed for a release cycle.
  console.error(`✗ build-cli: CLI entry not found at ${entry}`);
  console.error('  The CLI source moved. Update scripts/build-cli.ts and');
  console.error('  apps/electron/src/main/index.ts together — they must agree.');
  process.exit(1);
}

const outdir = resolve(ROOT, values.outdir ?? join('dist', 'cli'));
const isWindows = target.startsWith('windows');
// Append .exe only when the caller did not already spell it out. Earlier this
// unconditionally appended, so `--name=vorno-cli-bin` (the convention the mac
// build uses) produced `vorno-cli-bin.exe` on a Windows target while
// electron-builder.yml and main/index.ts expected something else — a silent
// mismatch that would ship a wrapper with no binary behind it.
const requestedName = values.name ?? 'vorno-cli';
const binName =
  isWindows && !requestedName.toLowerCase().endsWith('.exe')
    ? `${requestedName}.exe`
    : requestedName;
const outfile = join(outdir, binName);

mkdirSync(outdir, { recursive: true });

if (!values.quiet) {
  console.log(`build-cli: ${target} -> ${outfile}`);
}

const result = spawnSync(
  'bun',
  ['build', entry, '--compile', '--target', bunTarget, '--outfile', outfile],
  { cwd: ROOT, stdio: values.quiet ? 'pipe' : 'inherit' },
);

if (result.status !== 0) {
  console.error(`✗ build-cli: bun build failed (exit ${result.status})`);
  if (values.quiet && result.stderr) console.error(result.stderr.toString());
  process.exit(1);
}

if (!existsSync(outfile)) {
  console.error(`✗ build-cli: bun reported success but ${outfile} does not exist`);
  process.exit(1);
}

if (!isWindows) chmodSync(outfile, 0o755);

const sizeMb = (statSync(outfile).size / (1024 * 1024)).toFixed(1);

// Smoke test, but only when we built for the host — a cross-compiled binary
// cannot run here, and pretending otherwise would make the check a lie.
//
// Run it from a NEUTRAL cwd, and from a stripped environment, because that is
// what an installed binary actually faces: no bun on PATH, no CRAFT_* vars, no
// workspace around it. Inheriting this process's cwd would test the one
// situation a user is never in.
//
// Known quirk, deliberately not papered over: when the compiled binary is run
// with cwd set to the MONOREPO ROOT specifically, Bun resolves
// `@craft-agent/core/branding` against the on-disk workspace node_modules
// instead of the embedded bundle, and fails. Any other cwd — a subdirectory of
// the repo, /tmp, a user's home — works. It affects developers running the
// artifact in place, never a shipped install. Documented in the PLAN rather
// than hidden behind a smoke test that avoids it by accident.
if (target === hostTarget()) {
  const smoke = spawnSync(outfile, ['--help'], {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: tmpdir(),
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  });
  if (smoke.status !== 0 || !(smoke.stdout ?? '').includes('vorno-cli')) {
    console.error('✗ build-cli: the compiled binary did not answer --help.');
    console.error('  It was run from a clean environment with no bun and no CRAFT_* vars,');
    console.error('  which is the condition a real install faces.');
    console.error(`  exit=${smoke.status} stderr=${(smoke.stderr ?? '').slice(0, 400)}`);
    process.exit(1);
  }
  if (!values.quiet) console.log('  smoke test: --help OK under a stripped environment');
}

if (!values.quiet) {
  console.log(`✓ build-cli: ${binName} (${sizeMb} MB)`);
}
