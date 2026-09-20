'use strict'
// Minimal ASAR reader: lists entries and dumps them to a target directory.
const fs = require('node:fs')
const path = require('node:path')

const archive = process.argv[2]
const outDir = process.argv[3]

const fd = fs.openSync(archive, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const pickleSize = sizeBuf.readUInt32LE(4)
const payloadOffset = 8 + 4 // 8-byte file header + pickle sizeLength field
const jsonLenBuf = Buffer.alloc(4)
fs.readSync(fd, jsonLenBuf, 0, 4, payloadOffset)
const jsonLen = jsonLenBuf.readUInt32LE(0)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, payloadOffset + 4)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = payloadOffset + pickleSize

function walk (node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = path.join(prefix, name)
    if (entry.files) walk(entry, full)
    else {
      const offset = baseOffset + Number(entry.offset)
      const buf = Buffer.alloc(Number(entry.size))
      fs.readSync(fd, buf, 0, buf.length, offset)
      console.log(String(entry.size).padStart(9), full)
      const dest = path.join(outDir, full)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
    }
  }
}

fs.mkdirSync(outDir, { recursive: true })
walk(header, '')
fs.closeSync(fd)
