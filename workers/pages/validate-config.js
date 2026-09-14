import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync('wrangler.jsonc', 'utf8')
const isolation = ['"name": "vorno-pages"', '"bucket_name": "vorno-pages"', '"pattern": "pages.vorno.ai"']
if (!isolation.every(value => source.includes(value))) throw new Error('Pages Worker isolation invariant failed (name, bucket, or route changed)')
// Deploy gate discharged 2026-09-13 (SUV-0063 landed; privacy + retention approved).
// The isolation invariants above still apply and are the part worth keeping: they
// fail closed if the Worker name, bucket, or host ever drifts toward vorno-share.
// Namespace ids are now real and must stay distinct from any future vorno-share ids.
const namespaces = [...source.matchAll(/"namespace_id":\s*"(\d+)"/g)].map(m => m[1])
if (namespaces.length !== 2) throw new Error('Expected two rate-limit namespace ids')
if (new Set(namespaces).size !== 2) throw new Error('Rate-limit namespace ids must be distinct')
if (source.includes('REPLACE_WITH_')) throw new Error('Unreplaced namespace placeholder remains')

// Validate the real Wrangler schema with safe throwaway namespace IDs. `--dry-run`
// builds/parses locally and does not publish; no Cloudflare credential is supplied.
const dir = mkdtempSync(join(tmpdir(), 'vorno-pages-wrangler-'))
try {
  const config = source
    .replace('"main": "index.js"', `"main": ${JSON.stringify(join(process.cwd(), 'index.js'))}`)
  const configPath = join(dir, 'wrangler.jsonc')
  writeFileSync(configPath, config)
  const wrangler = join(process.cwd(), 'node_modules/.bin/wrangler')
  const result = spawnSync(wrangler, ['deploy', '--dry-run', '--config', configPath, '--outdir', join(dir, 'out')], {
    cwd: process.cwd(), env: { ...process.env, CLOUDFLARE_API_TOKEN: '', NO_PROXY: '*', no_proxy: '*' }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`Wrangler dry-run validation failed:\n${result.stderr || result.stdout}`)
  console.log(`Wrangler schema/dry-run passed with real namespace ids ${namespaces.join('/')}; isolation invariants hold.`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
