/**
 * Headless provisioning CLI for the trigger server (PLAN-013 work item 3).
 *
 * Additive entrypoint flags — NO route changes, NO server startup. These let an
 * operator seed a fresh deployment (container / VPS) without the Electron UI:
 *
 *   bun run apps/server/src/index.ts --generate-api-key <name> [--policy P] \
 *        [--workspaces a,b] [--max-concurrent N]
 *   bun run apps/server/src/index.ts --provision-llm-key <connection-slug> \
 *        [--from-file /path]        # otherwise reads the key from stdin
 *   bun run apps/server/src/index.ts --show-config
 *
 * Secrets never touch argv: the LLM key arrives on stdin or via --from-file
 * (Docker/systemd secret), so it stays out of shell history and `ps`. Generated
 * API keys are printed exactly once (only the SHA-256 hash is persisted).
 *
 * The heavy credential/LLM-connection modules are imported lazily inside the
 * command that needs them so `--generate-api-key` and `--show-config` stay cheap
 * and don't drag the vault into every server boot.
 */

import { readFileSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_DIR_RESOLUTION } from '@craft-agent/shared/config/paths';
import {
  loadServerConfig,
  generateApiKey,
  addApiKey,
  getConfigPath,
  type ApiKeyPermissions,
  type ServerConfig,
} from './config.ts';

export type PermissionPolicy = ApiKeyPermissions['permissionPolicy'];
export const VALID_POLICIES: PermissionPolicy[] = ['deny-all', 'allow-safe', 'allow-all'];
const DEFAULT_POLICY: PermissionPolicy = 'allow-safe';

// ---------------------------------------------------------------------------
// argv helpers
// ---------------------------------------------------------------------------

/** Value following `--name` (e.g. `--policy allow-safe`), or undefined. */
export function getFlagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  // Treat a following flag (or nothing) as "no value"
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

// ---------------------------------------------------------------------------
// --generate-api-key
// ---------------------------------------------------------------------------

export interface GenerateApiKeyArgs {
  name: string;
  permissions: ApiKeyPermissions;
}

/**
 * Parse `--generate-api-key <name> [--policy P] [--workspaces a,b] [--max-concurrent N]`.
 * Pure — does not touch disk. Returns a discriminated result so callers/tests can
 * assert on validation failures without catching exceptions.
 */
export function parseGenerateApiKeyArgs(
  argv: string[],
  defaults: { maxConcurrentSessions: number },
): { ok: true; value: GenerateApiKeyArgs } | { ok: false; error: string } {
  const name = getFlagValue(argv, '--generate-api-key');
  if (!name) {
    return { ok: false, error: 'Missing key name. Usage: --generate-api-key <name> [--policy P] [--workspaces a,b]' };
  }

  const policy = (getFlagValue(argv, '--policy') ?? DEFAULT_POLICY) as PermissionPolicy;
  if (!VALID_POLICIES.includes(policy)) {
    return { ok: false, error: `Invalid --policy "${policy}". Must be one of: ${VALID_POLICIES.join(', ')}.` };
  }

  const workspacesRaw = getFlagValue(argv, '--workspaces');
  const workspaceIds = workspacesRaw
    ? workspacesRaw.split(',').map(w => w.trim()).filter(Boolean)
    : [];

  let maxConcurrentSessions = defaults.maxConcurrentSessions;
  const maxRaw = getFlagValue(argv, '--max-concurrent');
  if (maxRaw !== undefined) {
    const parsed = Number.parseInt(maxRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: `Invalid --max-concurrent "${maxRaw}" (must be a positive integer).` };
    }
    maxConcurrentSessions = parsed;
  }

  return {
    ok: true,
    value: { name, permissions: { workspaceIds, permissionPolicy: policy, maxConcurrentSessions } },
  };
}

/**
 * Generate an API key, persist its hash to server-config.json, and return the
 * plaintext key (to be shown exactly once) plus its stored metadata.
 */
export function generateApiKeyCommand(args: GenerateApiKeyArgs): { fullKey: string; keyPrefix: string; id: string } {
  const config = loadServerConfig();
  const { fullKey, stored } = generateApiKey(args.name, args.permissions);
  addApiKey(config, stored);
  return { fullKey, keyPrefix: stored.keyPrefix, id: stored.id };
}

// ---------------------------------------------------------------------------
// --provision-llm-key
// ---------------------------------------------------------------------------

export interface ProvisionLlmKeyResult {
  connectionSlug: string;
  createdConnection: boolean;
  setAsDefault: boolean;
}

/**
 * Store an LLM provider API key in the machine-bound encrypted vault and ensure
 * a matching connection exists in config.json so a session can resolve it at
 * runtime. Idempotent: re-running updates the key in place.
 *
 * Heavy modules (credential vault, connection templates) are imported lazily.
 */
export async function provisionLlmKey(connectionSlug: string, apiKey: string): Promise<ProvisionLlmKeyResult> {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('No API key provided (stdin was empty and no --from-file given).');
  }

  const { getCredentialManager } = await import('@craft-agent/shared/credentials');
  const { getLlmConnection, addLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection } =
    await import('@craft-agent/shared/config');
  const { createBuiltInConnection } = await import('@craft-agent/server-core/domain');

  let createdConnection = false;
  if (!getLlmConnection(connectionSlug)) {
    // Throws a clear error for unknown slugs (e.g. typo) — surfaced to the operator.
    const connection = createBuiltInConnection(connectionSlug);
    addLlmConnection(connection);
    createdConnection = true;
  }

  const manager = getCredentialManager();
  await manager.setLlmApiKey(connectionSlug, apiKey.trim());

  // If no default connection is set yet, make this the default so a freshly
  // provisioned box can spawn sessions without further configuration.
  let setAsDefault = false;
  if (!getDefaultLlmConnection()) {
    setAsDefault = setDefaultLlmConnection(connectionSlug);
  }

  return { connectionSlug, createdConnection, setAsDefault };
}

/** Read the LLM key from --from-file, else from stdin (to EOF). */
async function readLlmKey(argv: string[]): Promise<string> {
  const fromFile = getFlagValue(argv, '--from-file');
  if (fromFile) {
    return readFileSync(fromFile, 'utf-8');
  }
  // Bun.stdin.text() reads the full stream to EOF.
  return await Bun.stdin.text();
}

// ---------------------------------------------------------------------------
// --show-config
// ---------------------------------------------------------------------------

export interface ShowConfigSummary {
  configDir: string;
  configDirReason: string;
  serverConfigPath: string;
  enabled: boolean;
  host: string;
  port: number;
  rateLimits: ServerConfig['rateLimits'];
  apiKeys: Array<{ name: string; keyPrefix: string; policy: PermissionPolicy; workspaceIds: string[] }>;
}

/**
 * Build a redacted, effective view of the server config (env overrides applied,
 * key hashes omitted — only names/prefixes/scopes shown). Safe to print.
 */
export function buildShowConfigSummary(): ShowConfigSummary {
  const config = loadServerConfig();
  return {
    configDir: CONFIG_DIR,
    configDirReason: CONFIG_DIR_RESOLUTION.reason,
    serverConfigPath: getConfigPath(),
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    rateLimits: config.rateLimits,
    apiKeys: config.apiKeys.map(k => ({
      name: k.name,
      keyPrefix: k.keyPrefix,
      policy: k.permissions.permissionPolicy,
      workspaceIds: k.permissions.workspaceIds,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface ProvisioningOutcome {
  /** True if a provisioning flag was present and handled (caller should exit). */
  handled: boolean;
  /** Process exit code to use when handled. */
  exitCode: number;
}

/**
 * Inspect argv for a provisioning flag and, if present, run it and return
 * `{ handled: true, exitCode }`. When no provisioning flag is present, returns
 * `{ handled: false }` and the caller proceeds to start the server.
 *
 * All output goes to stdout/stderr; this function never starts the HTTP server.
 */
export async function runProvisioningCli(argv: string[]): Promise<ProvisioningOutcome> {
  if (hasFlag(argv, '--generate-api-key')) {
    const config = loadServerConfig();
    const parsed = parseGenerateApiKeyArgs(argv, {
      maxConcurrentSessions: config.rateLimits.concurrentSessions,
    });
    if (!parsed.ok) {
      console.error(`[provision] ${parsed.error}`);
      return { handled: true, exitCode: 1 };
    }
    const { fullKey, keyPrefix, id } = generateApiKeyCommand(parsed.value);
    const { name, permissions } = parsed.value;
    console.log('');
    console.log(`API key created: ${name} (${id})`);
    console.log(`  policy:      ${permissions.permissionPolicy}`);
    console.log(`  workspaces:  ${permissions.workspaceIds.length ? permissions.workspaceIds.join(', ') : '(all)'}`);
    console.log(`  concurrency: ${permissions.maxConcurrentSessions}`);
    console.log(`  prefix:      ${keyPrefix}`);
    console.log('');
    console.log('  Save this key now — it is shown ONCE and only its hash is stored:');
    console.log('');
    console.log(`    ${fullKey}`);
    console.log('');
    return { handled: true, exitCode: 0 };
  }

  if (hasFlag(argv, '--provision-llm-key')) {
    const slug = getFlagValue(argv, '--provision-llm-key');
    if (!slug) {
      console.error('[provision] Missing connection slug. Usage: --provision-llm-key <connection-slug> [--from-file PATH]');
      return { handled: true, exitCode: 1 };
    }
    try {
      const key = await readLlmKey(argv);
      const result = await provisionLlmKey(slug, key);
      console.log('');
      console.log(`LLM key stored for connection: ${result.connectionSlug}`);
      console.log(`  connection created: ${result.createdConnection ? 'yes' : 'no (already existed)'}`);
      console.log(`  set as default:     ${result.setAsDefault ? 'yes' : 'no (a default already exists)'}`);
      console.log(`  vault:              ${CONFIG_DIR}/credentials.enc (machine-bound)`);
      console.log('');
      return { handled: true, exitCode: 0 };
    } catch (err) {
      console.error(`[provision] ${err instanceof Error ? err.message : String(err)}`);
      return { handled: true, exitCode: 1 };
    }
  }

  if (hasFlag(argv, '--show-config')) {
    console.log(JSON.stringify(buildShowConfigSummary(), null, 2));
    return { handled: true, exitCode: 0 };
  }

  return { handled: false, exitCode: 0 };
}
