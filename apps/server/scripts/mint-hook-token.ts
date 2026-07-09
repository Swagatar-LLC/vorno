/**
 * mint-hook-token — fork(PLAN-014)
 *
 * Generate a `craft_whk_` capability token for an existing WebhookReceived
 * matcher, write its `tokenHash`/`tokenPrefix` into the workspace's
 * automations.json (read-modify-write via .tmp + rename), and print the full
 * ingest URL exactly once. The plaintext token is NEVER persisted.
 *
 * Usage:
 *   bun apps/server/scripts/mint-hook-token.ts <workspace> <hookSlug>
 *
 * Pre-req: the WebhookReceived matcher with `hook.slug === <hookSlug>` already
 * exists in automations.json (create it by hand; this only mints the token).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { resolveAutomationsConfigPath, generateHookToken } from '@craft-agent/shared/automations';
import { loadServerConfig } from '../src/config.ts';

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [workspaceArg, hookSlug] = process.argv.slice(2);
if (!workspaceArg || !hookSlug) {
  fail('usage: bun apps/server/scripts/mint-hook-token.ts <workspace> <hookSlug>');
}

const workspace = getWorkspaceByNameOrId(workspaceArg);
if (!workspace) fail(`workspace "${workspaceArg}" not found`);

const configPath = resolveAutomationsConfigPath(workspace.rootPath);
if (!existsSync(configPath)) fail(`no automations.json at ${configPath}`);

let config: { automations?: Record<string, Array<Record<string, unknown>>> };
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (err) {
  fail(`could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
}

const matchers = config.automations?.WebhookReceived ?? [];
const matcher = matchers.find((m) => {
  const hook = m.hook as { slug?: string } | undefined;
  return hook?.slug === hookSlug;
});
if (!matcher) {
  fail(`no WebhookReceived matcher with hook.slug "${hookSlug}" in ${configPath}`);
}

const { token, tokenHash, tokenPrefix } = generateHookToken();
const hook = matcher.hook as Record<string, unknown>;
hook.tokenHash = tokenHash;
hook.tokenPrefix = tokenPrefix;

// Atomic write: .tmp + rename (same tolerance as backfillIds writes).
const tmpPath = `${configPath}.tmp`;
writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
renameSync(tmpPath, configPath);

const server = loadServerConfig();
const url = `http://${server.host}:${server.port}/hooks/${workspace.name}/${hookSlug}/${token}`;

console.log('Token minted and written to automations.json (tokenHash + tokenPrefix).');
console.log('The full token below is shown ONCE and is not stored — copy it now:\n');
console.log(`  POST ${url}\n`);
console.log(`  tokenPrefix: ${tokenPrefix}`);
