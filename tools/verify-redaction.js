'use strict'
// Fetch a file from the pushed GitHub blob and assert the redaction survived.
const https = require('node:https')
const token = process.env.GITHUB_TOKEN
const SLUG = 'hkhlpj/deepseek-harness-desktop'

function api (p, accept) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'api.github.com',
      path: p,
      headers: {
        'user-agent': 'dsh-verify',
        authorization: 'Bearer ' + token,
        accept: accept || 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

async function main () {
  const content = await api(`/repos/${SLUG}/contents/dist/builder-debug.yml?ref=main`, 'application/vnd.github.raw+json')
  const text = content.buf.toString('utf8')
  console.log('HTTP status:', content.status, '| bytes:', content.buf.length)

  const forbidden = ['24447', 'C:\\Users\\', 'DSH-EXE', 'AppData\\Local\\Temp\\t-', 'electron-builder\\Cache']
  const placeholders = ['<project>', '<electron-builder-cache>', '<temp>']

  let bad = 0
  for (const f of forbidden) {
    const n = text.split(f).length - 1
    console.log(`  forbidden "${f}": ${n} occurrence(s)${n ? '  <-- LEAK' : ''}`)
    if (n) bad += n
  }
  for (const p of placeholders) {
    const n = text.split(p).length - 1
    console.log(`  placeholder "${p}": ${n} occurrence(s)`)
  }

  console.log('\n=== pushed nsis include lines ===')
  for (const line of text.split(/\r?\n/)) {
    if (/!(include|addincludedir|addplugindir)/.test(line)) console.log('  ' + line.trim())
  }

  console.log('\n' + (bad === 0 ? 'REDACTION VERIFIED ON REMOTE: OK' : `REDACTION FAILED: ${bad} leak(s)`))
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
