'use strict'
// Validate a ZIP: parse the central directory, then inflate every entry and
// compare its CRC32 against the recorded one.
//
// usage: node verify-zip.js <zipPath>
const fs = require('node:fs')
const zlib = require('node:zlib')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32 (buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

const file = process.argv[2]
const buf = fs.readFileSync(file)

// Locate the End Of Central Directory record (scan back over the comment).
let eocd = -1
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
}
if (eocd < 0) { console.error('FAIL: no end-of-central-directory record'); process.exit(1) }

const count = buf.readUInt16LE(eocd + 10)
const cdSize = buf.readUInt32LE(eocd + 12)
const cdOffset = buf.readUInt32LE(eocd + 16)
console.log(`entries=${count} centralOffset=${cdOffset} centralSize=${cdSize} fileSize=${buf.length}`)

if (cdOffset + cdSize !== eocd) {
  console.error(`FAIL: central directory end (${cdOffset + cdSize}) != EOCD offset (${eocd})`)
  process.exit(1)
}

let p = cdOffset
let checked = 0
let rawTotal = 0
let bad = 0
let names = []
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) { console.error(`FAIL: bad central header at ${p}`); process.exit(1) }
  const method = buf.readUInt16LE(p + 10)
  const crc = buf.readUInt32LE(p + 16)
  const comp = buf.readUInt32LE(p + 20)
  const raw = buf.readUInt32LE(p + 24)
  const nameLen = buf.readUInt16LE(p + 28)
  const extraLen = buf.readUInt16LE(p + 30)
  const commentLen = buf.readUInt16LE(p + 32)
  const localOffset = buf.readUInt32LE(p + 42)
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

  // Local header -> data start.
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) { console.error(`FAIL: bad local header for ${name}`); process.exit(1) }
  const lNameLen = buf.readUInt16LE(localOffset + 26)
  const lExtraLen = buf.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + lNameLen + lExtraLen
  const stored = buf.subarray(dataStart, dataStart + comp)

  let content
  if (method === 0) content = stored
  else if (method === 8) content = zlib.inflateRawSync(stored)
  else { console.error(`FAIL: unknown method ${method} for ${name}`); process.exit(1) }

  if (content.length !== raw) { console.error(`FAIL: size mismatch ${name}: ${content.length} != ${raw}`); bad++ }
  else if (crc32(content) !== crc) { console.error(`FAIL: crc mismatch ${name}`); bad++ }

  rawTotal += raw
  checked++
  if (names.length < 5) names.push(name)
  p += 46 + nameLen + extraLen + commentLen
}

console.log('first entries:', names.join(', '))
console.log(`checked=${checked} rawTotal=${(rawTotal / 1048576).toFixed(1)} MiB failures=${bad}`)
console.log(bad === 0 ? 'ZIP OK' : 'ZIP INVALID')
process.exit(bad === 0 ? 0 : 1)
