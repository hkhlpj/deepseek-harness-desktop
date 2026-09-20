'use strict'
// Diagnose the remote repository: tree visibility, description encoding, releases.
const https = require('node:https')

const token = process.env.GITHUB_TOKEN
const SLUG = 'hkhlpj/deepseek-harness-desktop'

function api (path, accept) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'api.github.com',
      path,
      headers: {
        'user-agent': 'dsh-verify',
        authorization: 'Bearer ' + token,
        accept: accept || 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }))
    }).on('error', reject)
  })
}

async function main () {
  console.log('=== tree API diagnostics ===')
  const tr = await api(`/repos/${SLUG}/git/trees/main?recursive=1`)
  console.log('status:', tr.status, '| bytes:', tr.buf.length, '| truncated header:', tr.headers['x-truncated'] || 'n/a')
  const text = tr.buf.toString('utf8')
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { console.log('JSON parse failed:', e.message) }
  if (parsed) {
    console.log('truncated:', parsed.truncated, '| entries:', (parsed.tree || []).length)
    if (parsed.message) console.log('API message:', parsed.message)
    if (parsed.tree) {
      const blobs = parsed.tree.filter((e) => e.type === 'blob')
      console.log('blobs:', blobs.length)
      const big = blobs.filter((e) => e.size > 50 * 1048576).sort((a, b) => b.size - a.size)
      console.log('blobs >50MB:', big.length)
      for (const e of big.slice(0, 5)) console.log('   ', (e.size / 1048576).toFixed(1) + ' MiB', e.path)
      const zips = blobs.filter((e) => /\.zip$/i.test(e.path))
      console.log('zip blobs:', zips.length, zips.map((e) => e.path).join(', ') || '(none)')
    }
  } else {
    console.log('first 500 chars:', text.slice(0, 500))
  }

  console.log('\n=== description encoding ===')
  const repo = await api(`/repos/${SLUG}`)
  const j = JSON.parse(repo.buf.toString('utf8'))
  const d = j.description || ''
  const cps = [...d].map((c) => c.codePointAt(0))
  console.log('length:', d.length, '| U+FFFD count:', cps.filter((c) => c >= 0xfffd).length)
  console.log('description:', d)
  console.log('license:', j.license ? j.license.spdx_id : 'none', '| size KiB:', j.size)
  console.log('topics:', (j.topics || []).join(', '))

  console.log('\n=== releases ===')
  const rel = await api(`/repos/${SLUG}/releases`)
  for (const r of JSON.parse(rel.buf.toString('utf8'))) {
    console.log(r.tag_name, '|', r.name)
    for (const a of r.assets) console.log('   asset:', a.name, (a.size / 1048576).toFixed(1) + ' MiB', a.state)
    console.log('   body chars:', (r.body || '').length, '| has placeholder:', (r.body || '').includes('PLACEHOLDER'))
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
