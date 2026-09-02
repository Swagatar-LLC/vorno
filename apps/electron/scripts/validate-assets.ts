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
  // Match whole list entries under the `files:` key specifically.
  //
  // Two traps, both hit during development:
  //  - A naive `includes()` is wrong and silently so: "resources/bin/vorno-cli"
  //    is a prefix of "resources/bin/vorno-cli.cmd", so deleting the real entry
  //    still passed while the .cmd line remained.
  //  - Collecting every `- ` item in the file would accept an entry sitting
  //    under `extraResources:` or any other list, which ships different
  //    semantics. Only `files:` puts a path inside app.asar's file map.
  const lines = readFileSync(builderConfigPath, 'utf-8').split('\n');
  const listed = new Set<string>();
  let inFiles = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    // A new top-level key ends the block. List items and comments do not.
    if (inFiles && /^[A-Za-z_][\w-]*:/.test(line)) {
      inFiles = false;
    }
    if (!inFiles) continue;
    const item = line.trim();
    if (!item.startsWith('- ')) continue;
    listed.add(item.slice(2).trim().replace(/^["']|["']$/g, ''));
  }
  for (const w of CLI_WRAPPERS) {
    if (!listed.has(`resources/bin/${w}`)) {
      cliProblems.push(
        `resources/bin/${w} is not listed under \`files:\` in electron-builder.yml — it will NOT ship`,
      );
    }
  }
}

// The compiled binary is gitignored and only exists after scripts/build-cli.ts
// runs, so it cannot be required during a plain dev build. The platform dist
// scripts set CRAFT_REQUIRE_CLI_BIN=1 after their compile step, which is the
// only moment the assertion is both meaningful and true.
//
// This half is what catches the failure mode the wrapper check cannot:
// electron-builder SILENTLY SKIPS `files:` entries that do not exist — no
// warning, no error — so a platform build script missing its compile step
// packages successfully and ships a wrapper with nothing behind it.
if (process.env.CRAFT_REQUIRE_CLI_BIN === '1') {
  const binName = process.platform === 'win32' ? 'vorno-cli-bin.exe' : 'vorno-cli-bin';
  if (!existsSync(join('resources', 'bin', binName))) {
    cliProblems.push(
      `resources/bin/${binName} is missing — the compile step (scripts/build-cli.ts) ` +
        `did not run or wrote elsewhere. electron-builder would skip it silently ` +
        `and ship a wrapper with no binary.`,
    );
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
