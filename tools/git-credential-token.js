'use strict'
// Git credential helper: answers exactly one HTTPS credential request with the
// GitHub token taken from GITHUB_TOKEN. Keeps the token out of the remote URL,
// the git config, the reflog and every shell transcript.
//
// usage: git -c credential.helper='!node "<abs path>/git-credential-token.js"' fetch
const readline = require('node:readline')

const token = process.env.GITHUB_TOKEN
if (!token) {
  process.stderr.write('GITHUB_TOKEN is not set\n')
  process.exit(1)
}

const rl = readline.createInterface({ input: process.stdin })
let action = null

rl.on('line', (line) => {
  if (action === null) {
    action = line.trim()
    return
  }
  if (line.trim() === '') {
    // End of the request block: emit credentials for get/fill, nothing otherwise.
    if (action === 'get' || action === 'fill') {
      process.stdout.write('username=x-access-token\n')
      process.stdout.write('password=' + token + '\n')
    }
    process.exit(0)
  }
})
