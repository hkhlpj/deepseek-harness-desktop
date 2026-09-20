'use strict'
// Create (or reuse) the GitHub repository for this project.
// The token is read from the GITHUB_TOKEN environment variable and never
// written to disk or printed.
//
// usage: node github-create-repo.js <owner-or-empty> <repoName> <visibility>
const https = require('node:https')

const [, , ownerArg, repoName, visibility] = process.argv
const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is not set in the environment.')
  process.exit(1)
}

function api (method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null
    const req = https.request({
      host: 'api.github.com',
      path,
      method,
      headers: {
        'user-agent': 'dsh-publish',
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* non-JSON error body */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const DESCRIPTION =
  'DeepSeek Harness 独立桌面版：把 deepseek-harness 打包成点击即用的 Windows x64 桌面程序，' +
  '自带 Node.js 运行时，无需安装依赖，无命令行窗口。'

const HOMEPAGE = 'https://github.com/deepseek-ai/deepseek-harness'

const TOPICS = [
  'deepseek',
  'deepseek-harness',
  'electron',
  'desktop-app',
  'windows',
  'standalone',
  'portable',
  'ai-agent',
  'packaging'
]

async function main () {
  const me = await api('GET', '/user')
  if (me.status !== 200) {
    console.error('token rejected by GitHub (HTTP ' + me.status + '): ' + me.text.slice(0, 300))
    process.exit(1)
  }
  const owner = ownerArg || me.json.login
  console.log('authenticated as: ' + me.json.login)

  const existing = await api('GET', `/repos/${owner}/${repoName}`)
  if (existing.status === 200) {
    console.log('repository already exists: ' + existing.json.html_url)
    const patched = await api('PATCH', `/repos/${owner}/${repoName}`, {
      description: DESCRIPTION,
      homepage: HOMEPAGE,
      has_wiki: false,
      has_projects: false
    })
    console.log('metadata update: HTTP ' + patched.status)
  } else {
    const created = await api('POST', '/user/repos', {
      name: repoName,
      description: DESCRIPTION,
      homepage: HOMEPAGE,
      private: String(visibility || 'public').toLowerCase() !== 'public',
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    })
    if (created.status !== 201) {
      console.error('create failed HTTP ' + created.status + ': ' + created.text.slice(0, 500))
      process.exit(1)
    }
    console.log('created: ' + created.json.html_url)
    console.log('clone url: ' + created.json.clone_url)
  }

  const topics = await api('PUT', `/repos/${owner}/${repoName}/topics`, { names: TOPICS })
  console.log('topics: HTTP ' + topics.status)

  const final = await api('GET', `/repos/${owner}/${repoName}`)
  console.log('---')
  console.log('owner      : ' + owner)
  console.log('repo       : ' + repoName)
  console.log('remote     : https://github.com/' + owner + '/' + repoName + '.git')
  console.log('description: ' + (final.json && final.json.description))
  console.log('visibility : ' + (final.json && (final.json.private ? 'private' : 'public')))
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1) })
