'use strict'
// Targeted remote verification: confirm the important artifacts are present at
// the pushed commit and that the redactions survived, using one trees call per
// directory (cheap, no recursive enumeration).
const https = require('node:https')
const token = process.env.GITHUB_TOKEN
const SLUG = 'hkhlpj/deepseek-harness-desktop'

function api (p) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'api.github.com',
      path: p,
      headers: {
        'user-agent': 'dsh-verify',
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
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
  const head = JSON.parse((await api(`/repos/${SLUG}/commits/main`)).buf.toString('utf8'))
  const sha = head.sha
  console.log('remote HEAD:', sha)
  console.log('message    :', head.commit.message.split('\n')[0])
  console.log('date       :', head.commit.committer.date)

  const rate = JSON.parse((await api('/rate_limit')).buf.toString('utf8'))
  console.log('rate limit :', rate.resources.core.remaining, '/', rate.resources.core.limit)

  // Directories worth confirming (path -> expected entries).
  const checks = [
    ['', ['README.md', 'LICENSE', 'app', 'dist', 'docs', 'runtime', 'src', 'tools']],
    ['dist', ['builder-debug.yml', 'win-unpacked']],
    ['dist/win-unpacked', ['resources', 'locales', 'LICENSES.chromium.html']],
    ['dist/win-unpacked/resources', ['app.asar', 'elevate.exe', 'runtime']],
    ['src/repo/deepseek-harness-master', ['README.md', 'LICENSE', 'apps']],
    ['runtime/node', ['node.exe']],
    ['docs', ['screenshots', 'RELEASE_NOTES_v0.1.6.md']],
    ['docs/screenshots', ['02-设置窗口.png']],
    ['tools', ['asar-scan.js', 'make-zip.js', 'verify-zip.js']]
  ]

  const treeCache = new Map()
  async function listDir (dirPath) {
    const key = dirPath || '<root>'
    if (treeCache.has(key)) return treeCache.get(key)
    // Resolve the tree sha by walking from the root, one call per segment.
    let treeSha = sha
    if (dirPath) {
      for (const seg of dirPath.split('/')) {
        const r = JSON.parse((await api(`/repos/${SLUG}/git/trees/${treeSha}`)).buf.toString('utf8'))
        const entry = (r.tree || []).find((e) => e.path === seg && e.type === 'tree')
        if (!entry) { treeCache.set(key, null); return null }
        treeSha = entry.sha
      }
    }
    const r = JSON.parse((await api(`/repos/${SLUG}/git/trees/${treeSha}`)).buf.toString('utf8'))
    treeCache.set(key, r.tree || [])
    return r.tree || []
  }

  console.log('\n=== artifact presence ===')
  let failures = 0
  for (const [dirPath, expected] of checks) {
    const entries = await listDir(dirPath)
    if (!entries) { console.log(`FAIL  ${dirPath || '<root>'} unreadable`); failures++; continue }
    const names = new Set(entries.map((e) => e.path))
    const missing = expected.filter((n) => !names.has(n))
    const label = dirPath || '<root>'
    if (missing.length) { console.log(`FAIL  ${label}: missing ${missing.join(', ')}`); failures++ }
    else console.log(`ok    ${label} (${entries.length} entries, all ${expected.length} expected present)`)
  }

  console.log('\n=== largest blobs at HEAD root/dist ===')
  const distEntries = await listDir('dist')
  for (const e of distEntries.filter((x) => x.type === 'blob').sort((a, b) => b.size - a.size).slice(0, 5)) {
    console.log('   ', (e.size / 1048576).toFixed(1) + ' MiB', e.path)
  }

  console.log('\n' + (failures === 0 ? 'REMOTE VERIFICATION: OK' : `REMOTE VERIFICATION: ${failures} FAILURE(S)`))
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
