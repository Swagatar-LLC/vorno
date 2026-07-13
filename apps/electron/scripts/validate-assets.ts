/**
 * Post-build asset validation.
 *
 * Runs after copy-assets.ts (see package.json `build:validate`). Confirms the
 * critical build outputs landed in dist/ so a broken bundle fails loudly at
 * build time rather than at launch.
 *
 * Run: bun scripts/validate-assets.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';

// Assets that must exist for a launchable build. Paths are relative to
// apps/electron (the script's cwd during `bun run build`).
const REQUIRED_ASSETS: string[] = [
  join('dist', 'main.cjs'),
  join('dist', 'bootstrap-preload.cjs'),
  join('dist', 'interceptor.cjs'),
  join('dist', 'renderer', 'index.html'),
  // fork(PLAN-020): the desktop WebUI SPA bundled by copy-assets.ts.
  // Packaged runtime resolves join(process.resourcesPath, 'app', 'resources', 'webui').
  join('dist', 'resources', 'webui', 'index.html'),
  join('dist', 'resources', 'webui', 'login.html'),
];

const missing = REQUIRED_ASSETS.filter((p) => !existsSync(p));

if (missing.length > 0) {
  console.error('✗ validate-assets: required build outputs are missing:');
  for (const p of missing) {
    console.error(`    - ${p}`);
  }
  console.error(
    '\nBuild is incomplete. If the WebUI assets are missing, run `bun run webui:build`\n' +
      'then re-run the copy step (`bun run electron:build:assets`).',
  );
  process.exit(1);
}

console.log(`✓ validate-assets: all ${REQUIRED_ASSETS.length} required build outputs present`);
