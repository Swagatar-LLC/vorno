#!/usr/bin/env bun
/**
 * craft-remote — CLI companion for the Craft Agents HTTP trigger server.
 *
 * Usage:
 *   craft-remote status                     Server health check
 *   craft-remote keys                       List API keys
 *   craft-remote key create --name "name"   Generate new API key
 *   craft-remote sessions                   List active sessions
 *   craft-remote run "message"              One-shot: create → send → stream → delete
 *   craft-remote session                    Interactive REPL session
 *   craft-remote watch <session-id>         Attach to session's event stream
 *
 * Config (checked in order):
 *   CRAFT_REMOTE_URL  — Server URL (default: http://127.0.0.1:3847)
 *   CRAFT_REMOTE_KEY  — API key (required for authenticated commands)
 *   ~/.craft-agent/remote-config.json — { "url": "...", "apiKey": "..." }
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import {
  loadServerConfig,
  saveServerConfig,
  generateApiKey,
  addApiKey,
  revokeApiKey,
  getConfigPath,
  type ApiKeyPermissions,
} from './config.ts';

// ─── ANSI Colors ──────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// ─── Config Loading ───────────────────────────────────────────

interface RemoteConfig {
  url: string;
  apiKey: string | null;
}

function loadRemoteConfig(): RemoteConfig {
  const url = process.env.CRAFT_REMOTE_URL || '';
  const apiKey = process.env.CRAFT_REMOTE_KEY || '';

  // Try file-based config
  const configPath = join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.craft-agent',
    'remote-config.json'
  );

  let fileConfig: { url?: string; apiKey?: string } = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
  }

  return {
    url: url || fileConfig.url || 'http://127.0.0.1:3847',
    apiKey: apiKey || fileConfig.apiKey || null,
  };
}

// ─── HTTP Helpers ─────────────────────────────────────────────

async function apiFetch(
  config: RemoteConfig,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  try {
    return await fetch(`${config.url}${path}`, { ...options, headers });
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('connect')) {
      console.error(red(`Error: Cannot connect to server at ${config.url}`));
      console.error(dim('Is the server running? Start it with: bun run apps/server/src/index.ts'));
      process.exit(1);
    }
    throw err;
  }
}

async function apiJson(config: RemoteConfig, path: string, options: RequestInit = {}): Promise<any> {
  const res = await apiFetch(config, path, options);
  const body = await res.json();

  if (!res.ok) {
    console.error(red(`Error (${res.status}): ${body.error || JSON.stringify(body)}`));
    process.exit(1);
  }

  return body;
}

function requireApiKey(config: RemoteConfig): void {
  if (!config.apiKey) {
    console.error(red('Error: No API key configured.'));
    console.error(dim('Set CRAFT_REMOTE_KEY env var or create ~/.craft-agent/remote-config.json'));
    process.exit(1);
  }
}

// ─── SSE Parser ───────────────────────────────────────────────

async function streamSSE(
  response: Response,
  onEvent: (eventType: string, data: any) => boolean | void
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const shouldStop = onEvent(data.type, data);
            if (shouldStop) {
              reader.cancel();
              return;
            }
          } catch { /* skip malformed lines */ }
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') throw err;
  }
}

// ─── Commands ─────────────────────────────────────────────────

async function cmdStatus(config: RemoteConfig) {
  try {
    const res = await fetch(`${config.url}/health`);
    const data = await res.json();
    console.log(bold('Server Status'));
    console.log(`  URL:      ${config.url}`);
    console.log(`  Status:   ${green(data.status)}`);
    console.log(`  Version:  ${data.version}`);
    console.log(`  Uptime:   ${formatDuration(data.uptime)}`);
    console.log(`  Sessions: ${data.activeSessions}`);
  } catch {
    console.error(red(`Cannot connect to server at ${config.url}`));
    process.exit(1);
  }
}

async function cmdKeys() {
  const config = loadServerConfig();
  if (config.apiKeys.length === 0) {
    console.log(dim('No API keys configured.'));
    console.log(dim('Create one: craft-remote key create --name "My Key"'));
    return;
  }

  console.log(bold(`API Keys (${config.apiKeys.length}):`));
  for (const key of config.apiKeys) {
    const used = key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'never';
    const created = new Date(key.createdAt).toLocaleDateString();
    console.log(`  ${cyan(key.keyPrefix)}  ${key.name}`);
    console.log(`    ${dim(`id: ${key.id}  created: ${created}  used: ${used}  policy: ${key.permissions.permissionPolicy}`)}`);
  }
}

async function cmdKeyCreate(args: string[]) {
  let name = 'CLI Key';
  let policy: ApiKeyPermissions['permissionPolicy'] = 'allow-safe';
  let maxSessions = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--policy' && args[i + 1]) policy = args[++i] as any;
    else if (args[i] === '--max-sessions' && args[i + 1]) maxSessions = parseInt(args[++i]);
  }

  const config = loadServerConfig();
  const { fullKey, stored } = generateApiKey(name, {
    workspaceIds: [],
    permissionPolicy: policy,
    maxConcurrentSessions: maxSessions,
  });

  addApiKey(config, stored);

  console.log(green('API key created successfully!'));
  console.log('');
  console.log(bold('  Key: ') + yellow(fullKey));
  console.log('');
  console.log(red('  Save this key now — it cannot be shown again.'));
  console.log(dim(`  Name: ${name}  Policy: ${policy}  Max sessions: ${maxSessions}`));
  console.log('');
  console.log(dim('Usage:'));
  console.log(dim(`  export CRAFT_REMOTE_KEY="${fullKey}"`));
}

async function cmdKeyRevoke(args: string[]) {
  const keyId = args[0];
  if (!keyId) {
    console.error(red('Usage: craft-remote key revoke <key-id>'));
    process.exit(1);
  }

  const config = loadServerConfig();
  if (revokeApiKey(config, keyId)) {
    console.log(green(`Key ${keyId} revoked.`));
  } else {
    console.error(red(`Key ${keyId} not found.`));
    process.exit(1);
  }
}

async function cmdSessions(config: RemoteConfig) {
  requireApiKey(config);
  const sessions = await apiJson(config, '/api/sessions');

  if (sessions.length === 0) {
    console.log(dim('No active sessions.'));
    return;
  }

  console.log(bold(`Active Sessions (${sessions.length}):`));
  for (const s of sessions) {
    const status = s.status === 'processing' ? yellow(s.status) : green(s.status);
    console.log(`  ${s.sessionId}  ${status}  ${dim(`created: ${new Date(s.createdAt).toLocaleTimeString()}`)}`);
  }
}

async function cmdRun(config: RemoteConfig, message: string, args: string[]) {
  requireApiKey(config);

  let workspace = 'My Workspace';
  let model: string | undefined;
  let policy: string = 'deny-all';
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) workspace = args[++i];
    else if (args[i] === '--model' && args[i + 1]) model = args[++i];
    else if (args[i] === '--policy' && args[i + 1]) policy = args[++i];
    else if (args[i] === '--verbose') verbose = true;
  }

  // Create session
  const session = await apiJson(config, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: workspace,
      permissionPolicy: policy,
      ...(model ? { model } : {}),
    }),
  });

  if (verbose) {
    console.error(dim(`Session: ${session.sessionId}`));
  }

  // Cleanup on Ctrl+C
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      await apiFetch(config, `/api/sessions/${session.sessionId}/abort`, { method: 'POST' });
    } catch { /* ignore */ }
    try {
      await apiFetch(config, `/api/sessions/${session.sessionId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  };

  process.on('SIGINT', async () => {
    console.error(dim('\nAborting...'));
    await cleanup();
    process.exit(130);
  });

  try {
    // Send message
    const res = await apiFetch(config, `/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: message }),
    });

    if (!res.ok) {
      const body = await res.json();
      console.error(red(`Error: ${body.error || 'Failed to send message'}`));
      await cleanup();
      process.exit(1);
    }

    // Stream events
    await streamSSE(res, (type, data) => {
      switch (type) {
        case 'text_delta':
          process.stdout.write(data.text || '');
          break;
        case 'tool_start':
          if (verbose) console.error(dim(`[tool: ${data.toolName || data.name || '?'}]`));
          break;
        case 'tool_result':
          if (verbose) console.error(dim(`[result: ${data.toolName || '?'}]`));
          break;
        case 'usage_update':
          if (verbose) {
            console.error(dim(`[tokens: in=${data.inputTokens || '?'} out=${data.outputTokens || '?'}]`));
          }
          break;
        case 'error':
          console.error(red(`\nError: ${data.message}`));
          break;
        case 'complete':
          console.log(''); // Final newline
          if (verbose) console.error(dim('(done)'));
          return true;
      }
    });
  } finally {
    await cleanup();
  }
}

async function cmdWatch(config: RemoteConfig, sessionId: string) {
  requireApiKey(config);

  const res = await apiFetch(config, `/api/sessions/${sessionId}/events`);
  if (!res.ok) {
    const body = await res.json();
    console.error(red(`Error: ${body.error || 'Failed to connect'}`));
    process.exit(1);
  }

  console.error(dim(`Watching session ${sessionId}...`));

  await streamSSE(res, (type, data) => {
    switch (type) {
      case 'connected':
        console.error(dim('Connected.'));
        break;
      case 'text_delta':
        process.stdout.write(data.text || '');
        break;
      case 'tool_start':
        console.error(dim(`[tool: ${data.toolName || data.name || '?'}]`));
        break;
      case 'error':
        console.error(red(`Error: ${data.message}`));
        break;
      case 'complete':
        console.log('');
        console.error(dim('(done)'));
        break;
    }
  });
}

async function cmdSession(config: RemoteConfig, args: string[]) {
  requireApiKey(config);

  let workspace = 'My Workspace';
  let policy: string = 'allow-safe';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) workspace = args[++i];
    else if (args[i] === '--policy' && args[i + 1]) policy = args[++i];
  }

  // Create session
  const session = await apiJson(config, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspace, permissionPolicy: policy }),
  });

  console.log(dim(`Session created: ${session.sessionId}`));
  console.log(dim('Type your message and press Enter. Ctrl+C to exit.\n'));

  // Cleanup
  const cleanup = async () => {
    try {
      await apiFetch(config, `/api/sessions/${session.sessionId}/abort`, { method: 'POST' });
    } catch { /* ignore */ }
    try {
      await apiFetch(config, `/api/sessions/${session.sessionId}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  };

  process.on('SIGINT', async () => {
    console.log(dim('\nClosing session...'));
    await cleanup();
    process.exit(0);
  });

  // Simple REPL
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => new Promise<string>((resolve) => {
    rl.question(cyan('> '), (answer) => resolve(answer));
  });

  try {
    while (true) {
      const input = await prompt();
      if (!input.trim()) continue;

      if (input.trim() === '/quit' || input.trim() === '/exit') {
        break;
      }

      const res = await apiFetch(config, `/api/sessions/${session.sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: input }),
      });

      if (!res.ok) {
        const body = await res.json();
        console.error(red(`Error: ${body.error || 'Failed'}`));
        continue;
      }

      await streamSSE(res, (type, data) => {
        switch (type) {
          case 'text_delta':
            process.stdout.write(data.text || '');
            break;
          case 'error':
            console.error(red(`\nError: ${data.message}`));
            break;
          case 'complete':
            console.log('\n');
            return true;
        }
      });
    }
  } finally {
    rl.close();
    await cleanup();
  }
}

// ─── Utilities ────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function showHelp() {
  console.log(`
${bold('craft-remote')} — CLI for the Craft Agents HTTP trigger server

${bold('USAGE')}
  craft-remote <command> [options]

${bold('COMMANDS')}
  ${cyan('status')}                          Server health check
  ${cyan('keys')}                            List API keys
  ${cyan('key create')} --name "name"        Generate new API key
  ${cyan('key revoke')} <key-id>             Revoke an API key
  ${cyan('sessions')}                        List active sessions
  ${cyan('run')} "message"                   One-shot message (auto-creates and deletes session)
  ${cyan('session')}                         Interactive REPL session
  ${cyan('watch')} <session-id>              Attach to an existing session's event stream

${bold('RUN OPTIONS')}
  --workspace "name"              Workspace name (default: "My Workspace")
  --model <model-id>              Model to use
  --policy <policy>               Permission policy: deny-all, allow-safe, allow-all
  --verbose                       Show tool calls and token usage

${bold('CONFIG')}
  CRAFT_REMOTE_URL                Server URL (default: http://127.0.0.1:3847)
  CRAFT_REMOTE_KEY                API key for authentication
  ~/.craft-agent/remote-config.json   File-based config: { "url": "...", "apiKey": "..." }
  ~/.craft-agent/server-config.json   Server config (API keys, port, etc.)
`);
}

// ─── Main ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

const config = loadRemoteConfig();

switch (command) {
  case 'status':
    await cmdStatus(config);
    break;

  case 'keys':
    await cmdKeys();
    break;

  case 'key': {
    const subCmd = restArgs[0];
    if (subCmd === 'create') {
      await cmdKeyCreate(restArgs.slice(1));
    } else if (subCmd === 'revoke') {
      await cmdKeyRevoke(restArgs.slice(1));
    } else {
      console.error(red(`Unknown key command: ${subCmd}`));
      console.error(dim('Usage: craft-remote key create|revoke'));
      process.exit(1);
    }
    break;
  }

  case 'sessions':
    requireApiKey(config);
    await cmdSessions(config);
    break;

  case 'run': {
    const message = restArgs.find(a => !a.startsWith('--') && restArgs.indexOf(a) === 0);
    const flagArgs = restArgs.slice(message ? 1 : 0);
    if (!message) {
      console.error(red('Usage: craft-remote run "your message here" [--workspace ...] [--verbose]'));
      process.exit(1);
    }
    await cmdRun(config, message, flagArgs);
    break;
  }

  case 'session':
    await cmdSession(config, restArgs);
    break;

  case 'watch': {
    const sessionId = restArgs[0];
    if (!sessionId) {
      console.error(red('Usage: craft-remote watch <session-id>'));
      process.exit(1);
    }
    await cmdWatch(config, sessionId);
    break;
  }

  default:
    console.error(red(`Unknown command: ${command}`));
    showHelp();
    process.exit(1);
}
