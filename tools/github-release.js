'use strict'
// Create a GitHub release and upload its asset files.
// The token comes from GITHUB_TOKEN and is never printed.
//
// usage: node github-release.js <owner/repo> <tag> <title> <notesFile> <asset> [<asset>...]
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const [, , slug, tag, title, notesFile, ...assets] = process.argv
const token = process.env.GITHUB_TOKEN

if (!token) { console.error('GITHUB_TOKEN is not set'); process.exit(1) }
if (!slug || !tag) { console.error('usage: node github-release.js <owner/repo> <tag> <title> <notesFile> <asset...>'); process.exit(1) }

function api (method, apiPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const payload = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      : null
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'user-agent': 'dsh-publish',
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28',
        ...(payload ? { 'content-type': contentType || 'application/json', 'content-length': payload.length } : {})
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* may be an HTML error page */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function uploadAsset (uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath)
    const name = path.basename(filePath)
    const url = new URL(uploadUrl.replace('{?name,label}', ''))
    url.searchParams.set('name', name)

    const req = https.request({
      host: url.host,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'user-agent': 'dsh-publish',
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'content-type': 'application/octet-stream',
        'content-length': stat.size
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)

    let sent = 0
    let lastLog = 0
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      sent += chunk.length
      const now = Date.now()
      if (now - lastLog > 5000) {
        lastLog = now
        process.stdout.write(`    ${(sent / 1048576).toFixed(1)} / ${(stat.size / 1048576).toFixed(1)} MiB\n`)
      }
    })
    stream.on('error', reject)
    stream.pipe(req)
  })
}

async function main () {
  const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : ''

  // Reuse an existing release for this tag instead of failing out.
  let release = await api('GET', `/repos/${slug}/releases/tags/${tag}`)
  if (release.status === 200) {
    console.log(`release ${tag} already exists: ${release.json.html_url}`)
  } else {
    release = await api('POST', `/repos/${slug}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: title || tag,
      body: notes,
      draft: false,
      prerelease: false
    })
    if (release.status !== 201) {
      console.error(`create release failed HTTP ${release.status}: ${release.text.slice(0, 500)}`)
      process.exit(1)
    }
    console.log(`created release: ${release.json.html_url}`)
  }

  const existing = new Set((release.json.assets || []).map((a) => a.name))

  for (const asset of assets) {
    const name = path.basename(asset)
    if (!fs.existsSync(asset)) { console.error(`missing asset: ${asset}`); process.exit(1) }
    if (existing.has(name)) { console.log(`skip (already uploaded): ${name}`); continue }
    const size = fs.statSync(asset).size
    console.log(`uploading ${name} (${(size / 1048576).toFixed(1)} MiB)`)
    const res = await uploadAsset(release.json.upload_url, asset)
    if (res.status === 201) {
      console.log(`  OK ${res.json.browser_download_url}`)
    } else {
      console.error(`  FAILED HTTP ${res.status}: ${res.text.slice(0, 300)}`)
      process.exit(1)
    }
  }

  const final = await api('GET', `/repos/${slug}/releases/tags/${tag}`)
  console.log('---')
  console.log('release: ' + final.json.html_url)
  console.log('tag    : ' + final.json.tag_name)
  for (const a of final.json.assets) {
    console.log(`  asset: ${a.name}  ${(a.size / 1048576).toFixed(1)} MiB  state=${a.state}  downloads=${a.download_count}`)
  }
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1) })
