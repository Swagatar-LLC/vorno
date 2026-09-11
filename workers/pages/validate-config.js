import { readFileSync } from 'node:fs'

const config = readFileSync('wrangler.jsonc', 'utf8')
const required = ['"name": "vorno-pages"', '"bucket_name": "vorno-pages"', '"pattern": "pages.vorno.ai"', 'PAGE_CREATE_LIMIT', 'PAGE_PASSWORD_LIMIT']
if (!required.every(value => config.includes(value))) throw new Error('Pages Worker config is incomplete')
const placeholders = (config.match(/REPLACE_WITH_[A-Z_]+/g) || []).length
if (placeholders !== 2) throw new Error('Expected two undeployed rate-limit namespace placeholders')
if (process.argv.includes('--deploy') || process.env.VORNO_PAGES_DEPLOY_APPROVED === '1') {
  throw new Error('Deployment is gated by SUV-0063 plus privacy/retention approval; replace namespaces in a reviewed deployment change.')
}
console.log('Pages Worker config validated; deployment placeholders intentionally block deploy.')
