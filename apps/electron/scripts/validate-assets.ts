/**
 * Post-build asset validation.
 *
 * Runs after copy-assets.ts (see package.json `build:validate`). Confirms the
 * critical build outputs landed in dist/ so a broken bundle fails loudly at
 * build time rather than at launch.
 *
 * Run: bun scripts/validate-assets.ts
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Assets that must exist for a launchable build. Paths are relative to
// apps/electron (the script's cwd during `bun run build`).
const REQUIRED_ASSETS: string[] = [
  join('dist', 'main.cjs'),
  join('dist', 'bootstrap-preload.cjs'),
  join('dist', 'interceptor.cjs'),
  join('dist', 'renderer', 'index.html'),
  // fork(PLAN-020): the desktop WebUI SPA bundled by copy-assets.ts.
  // Packaged runtime resolves join(__dirname, 'resources', 'webui') — i.e.
  // Resources/app/dist/resources/webui, exactly what this staging check covers.
  join('dist', 'resources', 'webui', 'index.html'),
  join('dist', 'resources', 'webui', 'login.html'),
];

// fork(PLAN-049): the vorno-cli wrapper must exist AND be listed in
// electron-builder.yml. Both halves are checked because the failure that
// shipped 0.21.0 was exactly the second half: `resources/bin/craft-agent`
// existed on disk for releases, but the builder's `files:` list is enumerated
// file-by-file and never named it, so it was absent from every packaged build
// while looking perfectly present in the repo. A check for the file alone would
// have stayed green through that entire bug.
const CLI_WRAPPERS = ['vorno-cli', 'vorno-cli.cmd'];
const cliProblems: string[] = [];

for (const w of CLI_WRAPPERS) {
  if (!existsSync(join('resources', 'bin', w))) {
    cliProblems.push(`resources/bin/${w} is missing from the repo`);
  }
}

const builderConfigPath = 'electron-builder.yml';
if (existsSync(builderConfigPath)) {
  // Match whole list entries, not substrings. A naive `includes()` check is
  // wrong here and silently so: "resources/bin/vorno-cli" is a prefix of
  // "resources/bin/vorno-cli.cmd", so deleting the real entry still passed
  // while the .cmd line remained. Caught by deliberately unlisting the entry
  // and watching the check stay green.
  const listed = new Set(
    readFileSync(builderConfigPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, '')),
  );
  for (const w of CLI_WRAPPERS) {
    if (!listed.has(`resources/bin/${w}`)) {
      cliProblems.push(
        `resources/bin/${w} is not listed in electron-builder.yml — it will NOT ship`,
      );
    }
  }
}

if (cliProblems.length > 0) {
  console.error('✗ validate-assets: vorno-cli packaging is broken:');
  for (const p of cliProblems) console.error(`    - ${p}`);
  console.error(
    '\nThe CLI must both exist in resources/bin and be named in electron-builder.yml.\n' +
      'See scripts/build-cli.ts and PLAN-049.',
  );
  process.exit(1);
}

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
