// Measures PBKDF2 on the current WebCrypto runtime. This is a calibration aid,
// not a claim about Cloudflare CPU; rerun it with `wrangler dev` before deploy.
const iterations = Number(process.env.PBKDF2_ITERATIONS || 100_000)
const samples = Number(process.env.SAMPLES || 5)
const encoder = new TextEncoder()
const material = await crypto.subtle.importKey('raw', encoder.encode('benchmark-password'), 'PBKDF2', false, ['deriveBits'])
const salt = crypto.getRandomValues(new Uint8Array(16))
const timings = []
for (let index = 0; index < samples; index++) {
  const started = performance.now()
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256)
  timings.push(performance.now() - started)
}
timings.sort((a, b) => a - b)
console.log(JSON.stringify({ iterations, samples, minMs: timings[0], medianMs: timings[Math.floor(timings.length / 2)], maxMs: timings.at(-1) }, null, 2))
