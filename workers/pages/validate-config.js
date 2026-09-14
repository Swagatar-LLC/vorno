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
//
// Rate-limit namespace ids are self-assigned per Worker; no API allocates them, so
// there is no registry a single-Worker validator could consult. This file can only
// pin THIS Worker's ids, which is what it does: 2000-2099 is the block reserved for
// vorno-pages, and any change here is a deliberate edit rather than a silent drift.
// It cannot prove another Worker has not reused 2001/2002 — the reservation is a
// convention recorded in README.md, not an enforced invariant. Keeping vorno-share
// out of this block is that Worker's responsibility when it is written.
const PAGES_NAMESPACE_BLOCK = [2000, 2099]
const EXPECTED_NAMESPACES = { PAGE_CREATE_LIMIT: '2001', PAGE_PASSWORD_LIMIT: '2002' }
const namespaces = [...source.matchAll(/"name":\s*"(PAGE_[A-Z_]+)",\s*"namespace_id":\s*"(\d+)"/g)]
  .map(([, name, id]) => ({ name, id }))
if (namespaces.length !== 2) throw new Error('Expected two rate-limit namespace ids')
if (new Set(namespaces.map(n => n.id)).size !== 2) throw new Error('Rate-limit namespace ids must be distinct')
for (const { name, id } of namespaces) {
  if (EXPECTED_NAMESPACES[name] !== id) {
    throw new Error(`Rate-limit namespace ${name} expected id ${EXPECTED_NAMESPACES[name]}, found ${id}`)
  }
  if (Number(id) < PAGES_NAMESPACE_BLOCK[0] || Number(id) > PAGES_NAMESPACE_BLOCK[1]) {
    throw new Error(`Rate-limit namespace ${name} id ${id} is outside the reserved vorno-pages block ${PAGES_NAMESPACE_BLOCK.join('-')}`)
  }
}
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
  console.log(`Wrangler schema/dry-run passed with real namespace ids ${namespaces.map(n => n.id).join("/")}; isolation invariants hold.`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
