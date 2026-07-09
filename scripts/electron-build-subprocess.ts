/**
 * Build and stage the subprocess servers the packaged/prod Electron app needs
 * at runtime:
 *   - pi-agent-server   → Pi SDK sessions (providerType 'pi' / 'pi_compat')
 *   - session-mcp-server → session-scoped tools (SubmitPlan, config_validate, ...)
 *
 * This mirrors what `electron:dev` does (scripts/electron-dev.ts buildMcpServers)
 * for the prod/packaged path. Without it, `electron:build` (used by
 * electron:start / electron:prod / build-dmg.sh / electron:dist:mac) never
 * produces `packages/*-server/dist/index.js` nor stages
 * `apps/electron/resources/{pi-agent-server,session-mcp-server}`, so
 * `resolveServerPath` returns undefined and PiAgent throws
 * "piServerPath not configured. Cannot spawn Pi subprocess." (VOR-47).
 *
 * The staging helpers (buildMcpServers / copyPiAgentServer / copySessionServer)
 * already existed in scripts/build/common.ts but had no caller on the electron
 * path — this wires them in.
 */

import { join } from 'path';
import {
  buildMcpServers,
  copyPiAgentServer,
  copySessionServer,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common';

function resolvePlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform for subprocess build: ${process.platform}`);
}

function resolveArch(): Arch {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`Unsupported architecture for subprocess build: ${process.arch}`);
}

const rootDir = join(import.meta.dir, '..');
const electronDir = join(rootDir, 'apps', 'electron');

const config: BuildConfig = {
  platform: resolvePlatform(),
  arch: resolveArch(),
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir,
  electronDir,
};

console.log(`🔧 Building subprocess servers for ${config.platform}-${config.arch}...`);

// 1. Build session-mcp-server + pi-agent-server into packages/*-server/dist.
//    Covers the non-packaged prod-mode launch (electron:start / electron:prod),
//    where resolveServerPath walks up to packages/<name>/dist/index.js.
buildMcpServers(config);

// 2. Stage the built bundles into apps/electron/resources/*, matching the
//    electron-builder.yml `files` globs. Covers packaged (.app/.dmg) builds,
//    where resolveServerPath reads resources/<name>/index.js.
copySessionServer(config);
copyPiAgentServer(config);

console.log('✅ Subprocess servers built and staged into apps/electron/resources');
