#!/usr/bin/env bun
/**
 * webui-serve — launch packages/server with the WebUI bundle, bound to the
 * host's Tailscale IPv4 so it's reachable from any tailnet device (iPad, etc.)
 * while sharing ~/.craft-agent with the upstream desktop release.
 *
 * Required env (export from your shell — keep in a vault, not in this repo):
 *   CRAFT_SERVER_TOKEN     — long random token (used as WS bearer auth)
 *   CRAFT_WEBUI_PASSWORD   — short shareable password for browser login
 *
 * See PLAN-005 for the design.
 */

import { spawn, spawnSync } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const PORT = '9100'
const CONFIG_DIR = join(homedir(), '.craft-agent')

function fail(msg: string): never {
  console.error(`\n[webui-serve] ${msg}\n`)
  process.exit(1)
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    fail(`Missing required env var ${name}.\n  ${hint}`)
  }
  return value
}

function detectTailscaleIp(): string {
  let result
  try {
    result = spawnSync(['tailscale', 'ip', '-4'])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail(
      `Could not run \`tailscale ip -4\`: ${msg}\n` +
      `  Install Tailscale (https://tailscale.com/download) and run: tailscale up`
    )
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ''
    fail(
      `Could not detect Tailscale IP (\`tailscale ip -4\` failed${stderr ? `: ${stderr}` : ''}).\n` +
      `  Is Tailscale running? Try: tailscale up`
    )
  }
  const stdout = new TextDecoder().decode(result.stdout).trim()
  const ip = stdout.split(/\r?\n/)[0]?.trim()
  if (!ip) {
    fail('`tailscale ip -4` returned no address. Is Tailscale up?')
  }
  return ip
}

async function runStep(label: string, cmd: string[]): Promise<void> {
  console.log(`[webui-serve] ${label}...`)
  const proc = spawn({ cmd, cwd: ROOT_DIR, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    fail(`${label} failed (exit ${code}).`)
  }
}

const serverToken = requireEnv(
  'CRAFT_SERVER_TOKEN',
  'Generate one with: bun run packages/server/src/index.ts --generate-token'
)
const webuiPassword = requireEnv(
  'CRAFT_WEBUI_PASSWORD',
  'Set a short password for browser login (e.g., export CRAFT_WEBUI_PASSWORD=...)'
)

if (!existsSync(CONFIG_DIR)) {
  fail(
    `Config dir ${CONFIG_DIR} does not exist.\n` +
    `  This script reuses the upstream desktop release's data dir; install/launch the\n` +
    `  upstream desktop app once to create it.`
  )
}

const tailscaleIp = detectTailscaleIp()

// Always rebuild — per PLAN-005, no stale-bundle confusion.
await runStep('Building MCP/agent subprocesses', ['bun', 'run', 'server:build:subprocess'])
await runStep('Building WebUI bundle', ['bun', 'run', 'webui:build'])

const env: Record<string, string> = {
  ...process.env,
  CRAFT_CONFIG_DIR: CONFIG_DIR,
  CRAFT_RPC_HOST: tailscaleIp,
  CRAFT_RPC_PORT: PORT,
  CRAFT_WEBUI_DIR: 'apps/webui/dist',
  CRAFT_BUNDLED_ASSETS_ROOT: join(ROOT_DIR, 'apps', 'electron'),
  CRAFT_SERVER_TOKEN: serverToken,
  CRAFT_WEBUI_PASSWORD: webuiPassword,
  CRAFT_WEBUI_WS_URL: `ws://${tailscaleIp}:${PORT}`,
}

const url = `http://${tailscaleIp}:${PORT}`
console.log('')
console.log(`[webui-serve] WebUI: ${url}`)
console.log(`[webui-serve] Config dir: ${CONFIG_DIR}`)
console.log(`[webui-serve] Bind: ${tailscaleIp}:${PORT} (Tailscale, --allow-insecure-bind)`)
console.log('')

const child = spawn({
  cmd: [
    'bun',
    'run',
    'packages/server/src/index.ts',
    '--allow-insecure-bind',
  ],
  cwd: ROOT_DIR,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
})

const forward = (signal: NodeJS.Signals) => {
  try {
    child.kill(signal)
  } catch {
    // child already exited
  }
}
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

const code = await child.exited
process.exit(code ?? 0)
