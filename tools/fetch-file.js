'use strict'
// Download a file with redirect support and a simple progress log.
// usage: node fetch-file.js <url> <outPath> [expectedBytes]
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const [, , url, outPath] = process.argv

function download (target, dest, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'))
    https.get(target, { headers: { 'user-agent': 'dsh-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(download(res.headers.location, dest, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + target))
      }
      const total = Number(res.headers['content-length'] || 0)
      let seen = 0
      let lastLog = 0
      const out = fs.createWriteStream(dest)
      res.on('data', (chunk) => {
        seen += chunk.length
        const now = Date.now()
        if (now - lastLog > 3000) {
          lastLog = now
          const pct = total ? ((seen / total) * 100).toFixed(1) + '%' : '?'
          console.log(`  ${(seen / 1048576).toFixed(1)} MiB / ${(total / 1048576).toFixed(1)} MiB (${pct})`)
        }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve({ bytes: seen, total })))
      out.on('error', reject)
    }).on('error', reject)
  })
}

async function main () {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  console.log('GET ' + url)
  const r = await download(url, outPath, 0)
  console.log(`OK ${outPath} (${(r.bytes / 1048576).toFixed(1)} MiB)`)
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1) })
