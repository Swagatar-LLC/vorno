#!/usr/bin/env bun
/**
 * daily-driver — single command to run the full Craft Agent stack:
 *
 *   1. Headless `packages/server` bound to 127.0.0.1, serving WebUI on :9100
 *   2. Local Electron desktop in **thin-client mode** connected to ws://127.0.0.1:9100
 *   3. `tailscale serve --https=9100` proxies the loopback server out to the tailnet
 *      as https://<your-hostname>:9100 (TLS terminated by Tailscale's MagicDNS cert)
 *
 * Both UIs (desktop + iPad/browser) observe the same backend, sharing
 * ~/.craft-agent with the upstream desktop release.
 *
 * Required env (export from your shell — keep in a vault, not in this repo):
 *   CRAFT_SERVER_TOKEN     — long random token (WS bearer auth)
 *   CRAFT_WEBUI_PASSWORD   — short shareable password for browser login
 *
 * Ctrl-C cleanly stops Electron and the headless server, then removes the
 * tailscale serve mount we added (other serve mounts are left alone).
 */

import { spawn, spawnSync } from 'bun'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const PORT = '9100'
const CONFIG_DIR = join(homedir(), '.craft-agent')
const READY_MARKER = 'CRAFT_SERVER_URL='
const READY_TIMEOUT_MS = 60_000

function fail(msg: string): never {
  console.error(`\n[daily-driver] ${msg}\n`)
  process.exit(1)
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    fail(`Missing required env var ${name}.\n  ${hint}`)
  }
  return value
}

function detectTailscaleHostname(): string {
  let result
  try {
    result = spawnSync(['tailscale', 'status', '--json'])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail(
      `Could not run \`tailscale status --json\`: ${msg}\n` +
      `  Install Tailscale (https://tailscale.com/download) and run: tailscale up`
    )
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ''
    fail(
      `Could not query Tailscale node info (\`tailscale status --json\` failed${stderr ? `: ${stderr}` : ''}).\n` +
      `  Is Tailscale running? Try: tailscale up`
    )
  }
  const stdout = new TextDecoder().decode(result.stdout)
  let parsed: { Self?: { DNSName?: string } }
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    fail(`Could not parse \`tailscale status --json\` output: ${err instanceof Error ? err.message : String(err)}`)
  }
  const dnsName = parsed?.Self?.DNSName
  if (!dnsName) {
    fail('`tailscale status --json` returned no Self.DNSName. Is Tailscale up and signed in?')
  }
  return dnsName.replace(/\.$/, '')
}

interface ServeStatusJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

interface ServeMountState {
  mounted: boolean
  targetMatches: boolean
  existingTarget?: string
}

const SERVE_TARGET = `http://localhost:${PORT}`

function inspectServeMount(): ServeMountState {
  const result = spawnSync(['tailscale', 'serve', 'status', '--json'])
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ''
    fail(`tailscale serve status failed${stderr ? `: ${stderr}` : ''}`)
  }
  const stdout = new TextDecoder().decode(result.stdout).trim() || '{}'
  let parsed: ServeStatusJson
  try {
    parsed = JSON.parse(stdout) as ServeStatusJson
  } catch {
    return { mounted: false, targetMatches: false }
  }
  const portSuffix = `:${PORT}`
  const webEntry = Object.entries(parsed.Web ?? {}).find(([key]) => key.endsWith(portSuffix))?.[1]
  const proxy = webEntry?.Handlers?.['/']?.Proxy
  if (!proxy) return { mounted: false, targetMatches: false }
  return { mounted: true, targetMatches: proxy === SERVE_TARGET, existingTarget: proxy }
}

function ensureServeMount(): { addedByUs: boolean } {
  const status = inspectServeMount()
  if (status.mounted) {
    if (status.targetMatches) {
      console.log(`[daily-driver] tailscale serve already mounts https=${PORT} → ${SERVE_TARGET}; reusing.`)
      return { addedByUs: false }
    }
    fail(
      `tailscale serve already has a mount on https=${PORT} pointing to ${status.existingTarget}.\n` +
      `  Refusing to clobber. Remove it first with:\n` +
      `    tailscale serve --https=${PORT} off`
    )
  }
  console.log(`[daily-driver] tailscale serve --bg --https=${PORT} ${SERVE_TARGET}`)
  const result = spawnSync(['tailscale', 'serve', '--bg', `--https=${PORT}`, SERVE_TARGET])
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ''
    fail(`tailscale serve add failed${stderr ? `: ${stderr}` : ''}`)
  }
  return { addedByUs: true }
}

function removeServeMount(): void {
  const result = spawnSync(['tailscale', 'serve', `--https=${PORT}`, 'off'])
  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : ''
    console.warn(`[daily-driver] tailscale serve --https=${PORT} off failed${stderr ? `: ${stderr}` : ''}`)
  }
}

async function runStep(label: string, cmd: string[]): Promise<void> {
  console.log(`[daily-driver] ${label}...`)
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

const tailscaleHost = detectTailscaleHostname()
const localWsUrl = `ws://127.0.0.1:${PORT}`
const localHttpUrl = `http://127.0.0.1:${PORT}`
const tailnetHttpsUrl = `https://${tailscaleHost}:${PORT}`

await runStep('Building MCP/agent subprocesses', ['bun', 'run', 'server:build:subprocess'])
await runStep('Building WebUI bundle', ['bun', 'run', 'webui:build'])
await runStep('Building Electron bundle', ['bun', 'run', 'electron:build'])

const banner = [
  '',
  '┌──────────────────────────────────────────────────────────────────',
  '│ Vorno — Daily Driver',
  '├──────────────────────────────────────────────────────────────────',
  `│  Tailnet URL     : ${tailnetHttpsUrl}`,
  `│  Local URL       : ${localHttpUrl}`,
  `│  Config dir      : ${CONFIG_DIR}`,
  '│',
  `│  Server token    : ${serverToken}`,
  `│  Web password    : ${webuiPassword}`,
  '└──────────────────────────────────────────────────────────────────',
  '',
].join('\n')
console.log(banner)

// ── 1. Spawn headless server (loopback only) ───────────────────────────────
const serverEnv: Record<string, string> = {
  ...process.env,
  CRAFT_CONFIG_DIR: CONFIG_DIR,
  CRAFT_RPC_HOST: '127.0.0.1',
  CRAFT_RPC_PORT: PORT,
  CRAFT_WEBUI_DIR: 'apps/webui/dist',
  CRAFT_BUNDLED_ASSETS_ROOT: join(ROOT_DIR, 'apps', 'electron'),
  CRAFT_SERVER_TOKEN: serverToken,
  CRAFT_WEBUI_PASSWORD: webuiPassword,
  // CRAFT_WEBUI_WS_URL intentionally unset: /api/config now derives ws/wss
  // from the request origin, so Electron-on-loopback gets ws:// and tailnet
  // browsers behind `tailscale serve` get wss://.
}
delete serverEnv.CRAFT_WEBUI_WS_URL

console.log('[daily-driver] Starting headless server on 127.0.0.1...')
const server = spawn({
  cmd: ['bun', 'run', 'packages/server/src/index.ts'],
  cwd: ROOT_DIR,
  env: serverEnv,
  stdout: 'pipe',
  stderr: 'inherit',
})

// Wait for "CRAFT_SERVER_URL=" marker (server has bound the port and is ready)
async function waitForReady(): Promise<void> {
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + READY_TIMEOUT_MS
  let buffer = ''
  let ready = false
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    process.stdout.write(chunk)
    buffer += chunk
    if (buffer.includes(READY_MARKER)) {
      ready = true
      break
    }
  }
  reader.releaseLock()
  if (!ready) fail('Headless server did not become ready within 60s.')
  // Drain remaining stdout to console in the background.
  ;(async () => {
    for await (const chunk of server.stdout as any) {
      process.stdout.write(chunk)
    }
  })().catch(() => {})
}

await waitForReady()
console.log('[daily-driver] Headless server ready.')

// ── 2. Publish loopback server to tailnet via tailscale serve ──────────────
const { addedByUs: serveAddedByUs } = ensureServeMount()

// ── 3. Spawn Electron in thin-client mode (connects to loopback) ───────────
const electronEnv: Record<string, string> = {
  ...process.env,
  CRAFT_SERVER_URL: localWsUrl,
  CRAFT_SERVER_TOKEN: serverToken,
}
delete electronEnv.CRAFT_CONFIG_DIR

const electronBin = join(ROOT_DIR, 'node_modules', '.bin', 'electron')
console.log('[daily-driver] Launching Electron (thin-client)...')
const electron = spawn({
  cmd: [electronBin, 'apps/electron'],
  cwd: ROOT_DIR,
  env: electronEnv,
  stdout: 'inherit',
  stderr: 'inherit',
})

// ── 4. Lifecycle: graceful shutdown on Ctrl-C, or if either child dies ──────
let shuttingDown = false
async function shutdown(signal: NodeJS.Signals | 'child-exit'): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[daily-driver] Shutting down (${signal})...`)
  const sig = signal === 'child-exit' ? 'SIGTERM' : signal
  try { electron.kill(sig) } catch {}
  try { server.kill(sig) } catch {}
  const results = await Promise.allSettled([electron.exited, server.exited])
  const codes = results.map((r) => (r.status === 'fulfilled' ? r.value : 'err'))
  if (serveAddedByUs) {
    removeServeMount()
  }
  console.log(`[daily-driver] Stopped (electron=${codes[0]}, server=${codes[1]}).`)
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// If either child exits on its own, take the other one with it.
;(async () => {
  const code = await electron.exited
  if (!shuttingDown) {
    console.log(`[daily-driver] Electron exited (code=${code}); stopping server.`)
    await shutdown('child-exit')
  }
})().catch(() => {})
;(async () => {
  const code = await server.exited
  if (!shuttingDown) {
    console.log(`[daily-driver] Server exited (code=${code}); stopping Electron.`)
    await shutdown('child-exit')
  }
})().catch(() => {})
