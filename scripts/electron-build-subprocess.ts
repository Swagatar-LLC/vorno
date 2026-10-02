/**
 * Build and stage the Pi subprocess for prod and packaged Electron launches.
 * Session tools now run in-process; upstream no longer builds the obsolete
 * session-MCP helper. Use the same build API as the dev and server entry points.
 */

import { join } from 'path';
import {
  buildSubprocessServers,
  copyPiAgentServer,
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

// 1. Build pi-agent-server into packages/pi-agent-server/dist.
//    Covers the non-packaged prod-mode launch (electron:start / electron:prod),
//    where resolveServerPath walks up to packages/<name>/dist/index.js.
buildSubprocessServers(config);

// 2. Stage the built bundles into apps/electron/resources/*, matching the
//    electron-builder.yml `files` globs. Covers packaged (.app/.dmg) builds,
//    where resolveServerPath reads resources/<name>/index.js.
copyPiAgentServer(config);

console.log('✅ Subprocess servers built and staged into apps/electron/resources');
