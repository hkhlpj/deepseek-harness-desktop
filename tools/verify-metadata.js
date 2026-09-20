'use strict'
// Fast metadata checks: description, topics, license, release assets/body.
const https = require('node:https')
const token = process.env.GITHUB_TOKEN
const SLUG = 'hkhlpj/deepseek-harness-desktop'

function api (path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'api.github.com',
      path,
      headers: {
        'user-agent': 'dsh-verify',
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
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
  const repo = JSON.parse((await api(`/repos/${SLUG}`)).buf.toString('utf8'))
  const d = repo.description || ''
  console.log('=== repository ===')
  console.log('name       :', repo.full_name)
  console.log('url        :', repo.html_url)
  console.log('description:', d)
  console.log('desc length:', d.length, '| U+FFFD count:', [...d].filter((c) => c.codePointAt(0) >= 0xfffd).length)
  console.log('topics     :', (repo.topics || []).join(', '))
  console.log('license    :', repo.license ? repo.license.spdx_id : 'none')
  console.log('default    :', repo.default_branch, '| size KiB:', repo.size, '| stars:', repo.stargazers_count)

  console.log('\n=== releases ===')
  for (const r of JSON.parse((await api(`/repos/${SLUG}/releases`)).buf.toString('utf8'))) {
    const body = r.body || ''
    console.log(r.tag_name, '|', r.name, '|', r.html_url)
    console.log('   body chars:', body.length, '| placeholder left:', body.includes('PLACEHOLDER'))
    console.log('   sha256 block present:', body.includes('6fb9d182f0a3653859355456ccd797789b7a46007cab182df0d957d857519e99'))
    for (const a of r.assets) console.log('   asset:', a.name.padEnd(42), (a.size / 1048576).toFixed(1) + ' MiB', a.state)
  }

  console.log('\n=== root contents (non-recursive) ===')
  const contents = JSON.parse((await api(`/repos/${SLUG}/contents/`)).buf.toString('utf8'))
  for (const c of contents) console.log('  ', c.type.padEnd(4), c.name)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
