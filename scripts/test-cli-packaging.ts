#!/usr/bin/env bun
/**
 * Regression harness for the standalone CLI delivery path.
 *
 * It runs on the host platform in CI, then statically verifies the platform
 * packaging scripts that cannot execute on that host. The executable smoke is
 * intentionally launched through the shipped POSIX wrapper from the monorepo
 * root: that is the resolver case that previously selected workspace modules
 * instead of the compiled bundle.
 */

import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = join(ROOT, 'apps', 'electron', 'resources', 'bin', 'vorno-cli');

function fail(message: string): never {
  console.error(`✗ cli packaging test: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${result.status ?? 'without status'}\n` +
      `${result.stderr || result.stdout || '(no output)'}`,
    );
  }
  return result;
}

function assertIncludes(source: string, expected: string, label: string): void {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function assertPlatformBuildContracts(): void {
  const contracts = [
    {
      file: 'apps/electron/scripts/build-dmg.sh',
      expected: [
        'scripts/build-cli.ts',
        '--target="darwin-${ARCH}"',
        '--outdir="$ELECTRON_DIR/resources/bin"',
        '--name="vorno-cli-bin"',
        'CRAFT_REQUIRE_CLI_BIN=1 bun run electron:build',
      ],
    },
    {
      file: 'apps/electron/scripts/build-linux.sh',
      expected: [
        'scripts/build-cli.ts',
        '--target="linux-${ARCH}"',
        '--outdir="$ELECTRON_DIR/resources/bin"',
        '--name="vorno-cli-bin"',
        'CRAFT_REQUIRE_CLI_BIN=1 bun run electron:build',
      ],
    },
    {
      file: 'apps/electron/scripts/build-win.ps1',
      expected: [
        'scripts/build-cli.ts --target=windows-x64 --outdir="$ElectronDir\\resources\\bin" --name=vorno-cli-bin',
        '$env:CRAFT_REQUIRE_CLI_BIN = "1"',
      ],
    },
  ];

  for (const { file, expected } of contracts) {
    const source = readFileSync(join(ROOT, file), 'utf-8');
    for (const text of expected) assertIncludes(source, text, file);
  }

  const windowsWrapper = readFileSync(`${WRAPPER}.cmd`, 'utf-8');
  for (const text of [
    'set "VORNO_CLI_WORKDIR=%CD%"',
    'cd /d "%~dp0"',
    'cd /d "%VORNO_CLI_WORKDIR%"',
    'exit /b 127',
  ]) {
    assertIncludes(windowsWrapper, text, 'apps/electron/resources/bin/vorno-cli.cmd');
  }
}

const staging = mkdtempSync(join(tmpdir(), 'vorno-cli-packaging-'));
const installDir = join(staging, 'install');
const fakeCli = join(staging, 'fake-cli');

try {
  assertPlatformBuildContracts();

  run(process.execPath, [join(ROOT, 'scripts', 'install-cli.ts')], {
    cwd: ROOT,
    env: { ...process.env, VORNO_CLI_INSTALL_DIR: installDir },
  });

  const binary = join(installDir, process.platform === 'win32' ? 'vorno-cli.exe' : 'vorno-cli');
  if (process.platform === 'win32') {
    // The .cmd launcher contract is statically covered below. Keep the host
    // smoke runnable without adding a quoting-sensitive cmd.exe harness here.
    const smoke = run(binary, ['--help'], { cwd: staging });
    if (!smoke.stdout.includes('vorno-cli')) {
      fail(`installed binary did not produce CLI help:\n${smoke.stdout}\n${smoke.stderr}`);
    }
  } else {
    const smoke = run(WRAPPER, ['--help'], {
      cwd: ROOT,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME || tmpdir(),
        CRAFT_VORNO_CLI_BIN: binary,
      },
    });
    if (!smoke.stdout.includes('vorno-cli')) {
      fail(`packaged wrapper did not produce CLI help:\n${smoke.stdout}\n${smoke.stderr}`);
    }

    writeFileSync(fakeCli, '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$VORNO_CLI_WORKDIR"\n');
    chmodSync(fakeCli, 0o755);
    const cwdProbe = run(WRAPPER, [], {
      cwd: ROOT,
      env: { PATH: '/usr/bin:/bin', CRAFT_VORNO_CLI_BIN: fakeCli },
    });
    const [runtimeCwd, originalCwd] = String(cwdProbe.stdout ?? '').trim().split('\n');
    const wrapperDir = dirname(WRAPPER);
    if (runtimeCwd !== wrapperDir || originalCwd !== ROOT) {
      fail(`wrapper cwd contract failed: runtime=${runtimeCwd} original=${originalCwd}`);
    }
  }

  console.log('✓ cli packaging: compiled install, host runtime smoke, and platform build contracts');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
