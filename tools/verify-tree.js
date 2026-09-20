'use strict'
// Verify a GitHub repository tree by walking the non-recursive trees API.
// The recursive endpoint times out on repositories with tens of thousands of
// entries, so this walks one directory at a time using the git/trees/<sha> API.
//
// usage: node verify-tree.js <owner/repo> [localRoot]
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const token = process.env.GITHUB_TOKEN
const SLUG = process.argv[2] || 'hkhlpj/deepseek-harness-desktop'
const localRoot = process.argv[3]

function api (apiPath) {
  return new Promise((resolve, reject) => {
    const attempt = (tries) => {
      https.get({
        host: 'api.github.com',
        path: apiPath,
        headers: {
          'user-agent': 'dsh-verify',
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        }
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === 403 && /rate limit/i.test(text) && tries > 0) {
            console.log('  (rate limited, waiting 60s)')
            setTimeout(() => attempt(tries - 1), 60000)
            return
          }
          try { resolve({ status: res.statusCode, json: JSON.parse(text) }) }
          catch { resolve({ status: res.statusCode, json: null, text }) }
        })
      }).on('error', (e) => {
        if (tries > 0) setTimeout(() => attempt(tries - 1), 2000)
        else reject(e)
      })
    }
    attempt(3)
  })
}

async function main () {
  const head = await api(`/repos/${SLUG}/commits/main`)
  const sha = head.json.sha
  console.log('remote HEAD:', sha, '|', head.json.commit.message.split('\n')[0])

  const files = []
  const queue = [{ sha, prefix: '' }]
  let dirs = 0
  let totalBytes = 0

  while (queue.length) {
    const { sha: treeSha, prefix } = queue.shift()
    const res = await api(`/repos/${SLUG}/git/trees/${treeSha}`)
    if (!res.json || !res.json.tree) {
      console.error('tree fetch failed for', prefix || '<root>', res.status, JSON.stringify(res.json).slice(0, 200))
      process.exit(1)
    }
    dirs += 1
    for (const e of res.json.tree) {
      const full = prefix ? prefix + '/' + e.path : e.path
      if (e.type === 'tree') queue.push({ sha: e.sha, prefix: full })
      else if (e.type === 'blob') { files.push({ path: full, size: e.size }); totalBytes += e.size }
    }
    if (dirs % 2000 === 0) console.log(`  walked ${dirs} dirs, ${files.length} blobs...`)
  }

  console.log(`\nremote: ${dirs} directories, ${files.length} blobs, ${(totalBytes / 1048576).toFixed(1)} MiB`)

  const big = files.filter((f) => f.size > 50 * 1048576).sort((a, b) => b.size - a.size)
  console.log('blobs >50 MiB:', big.length)
  for (const f of big.slice(0, 5)) console.log('   ', (f.size / 1048576).toFixed(1) + ' MiB', f.path)

  const over100 = files.filter((f) => f.size > 100 * 1048576)
  console.log('blobs >100 MiB (would break push):', over100.length)

  const zips = files.filter((f) => /\.zip$/i.test(f.path))
  console.log('zip blobs in repo:', zips.length, zips.map((f) => f.path).join(', ') || '(none)')

  if (!localRoot || !fs.existsSync(localRoot)) return

  // Compare against the local working tree, applying the same rules .gitignore does.
  console.log('\n=== comparing against local tree ===')
  const local = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + entry.name : entry.name
      if (r === '.git' || r.startsWith('.git/') || r === '.git-backup' || r.startsWith('.git-backup/')) continue
      if (r === 'tools/git' || r.startsWith('tools/git/')) continue
      if (r === 'tools/verify-clone' || r.startsWith('tools/verify-clone/')) continue
      if (r.startsWith('app/node_modules/')) continue
      if (/^dist\/[^/]+\.(exe|zip|7z|blockmap)$/i.test(r)) continue
      if (r === 'dist/win-unpacked/DeepSeek Harness.exe') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, r)
      else if (entry.isFile()) local.push(r)
    }
  }
  walk(localRoot, '')

  const remoteSet = new Set(files.map((f) => f.path))
  const localSet = new Set(local)
  const missing = local.filter((f) => !remoteSet.has(f))
  const extra = files.filter((f) => !localSet.has(f.path))

  console.log('local files (after ignore rules):', local.length)
  console.log('missing on remote:', missing.length)
  for (const m of missing.slice(0, 20)) console.log('   -', m)
  console.log('extra on remote:', extra.length)
  for (const e of extra.slice(0, 20)) console.log('   +', e.path)
  console.log(missing.length === 0 && extra.length === 0 ? '\nTREE MATCH: OK' : '\nTREE MISMATCH')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
