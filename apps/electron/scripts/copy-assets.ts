/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
cpSync('resources', 'dist/resources', { recursive: true });

console.log('✓ Copied resources/ → dist/resources/');

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join('..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join('dist', 'resources', 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}

// fork(PLAN-020): Bundle the desktop WebUI SPA into the packaged app.
// Source: apps/webui/dist (built by `bun run webui:build`).
// Destination: dist/resources/webui/ — packaged as Resources/app/dist/resources/
// webui, which the runtime resolves as join(__dirname, 'resources', 'webui')
// (__dirname = the dist/ dir holding main.cjs; same root as setBundledAssetsRoot).
const webuiSrc = join('..', '..', 'apps', 'webui', 'dist');
const webuiDest = join('dist', 'resources', 'webui');
if (existsSync(webuiSrc)) {
  mkdirSync(webuiDest, { recursive: true });
  cpSync(webuiSrc, webuiDest, { recursive: true });
  console.log('✓ Copied apps/webui/dist → dist/resources/webui/');
} else {
  // Graceful degrade: dev builds without `webui:build` have no dist yet.
  // Do NOT throw — the WebUiSupervisor surfaces an actionable error at runtime.
  console.log(
    '⚠ apps/webui/dist not found — skipping WebUI bundle (run `bun run webui:build`)',
  );
}
