import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync('wrangler.jsonc', 'utf8')
const placeholder = 'REPLACE_WITH_ISOLATED_PAGES_'
if ((source.match(/REPLACE_WITH_ISOLATED_PAGES_[A-Z_]+/g) || []).length !== 2) throw new Error('Expected two isolated undeployed namespace placeholders')
if (process.argv.includes('--deploy') || process.env.VORNO_PAGES_DEPLOY_APPROVED === '1') {
  throw new Error('Deployment is gated by SUV-0063 plus privacy/retention approval.')
}

// Validate the real Wrangler schema with safe throwaway namespace IDs. `--dry-run`
// builds/parses locally and does not publish; no Cloudflare credential is supplied.
const dir = mkdtempSync(join(tmpdir(), 'vorno-pages-wrangler-'))
try {
  const config = source
    .replaceAll(/REPLACE_WITH_ISOLATED_PAGES_[A-Z_]+/g, '00000000000000000000000000000000')
    .replace('"main": "index.js"', `"main": ${JSON.stringify(join(process.cwd(), 'index.js'))}`)
  const configPath = join(dir, 'wrangler.jsonc')
  writeFileSync(configPath, config)
  const wrangler = join(process.cwd(), 'node_modules/.bin/wrangler')
  const result = spawnSync(wrangler, ['deploy', '--dry-run', '--config', configPath, '--outdir', join(dir, 'out')], {
    cwd: process.cwd(), env: { ...process.env, CLOUDFLARE_API_TOKEN: '', NO_PROXY: '*', no_proxy: '*' }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`Wrangler dry-run validation failed:\n${result.stderr || result.stdout}`)
  console.log('Wrangler schema/dry-run passed with temporary safe namespace IDs; placeholders still block deployment.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
