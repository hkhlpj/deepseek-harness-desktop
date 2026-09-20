'use strict'
// Create a ZIP of a directory using zlib deflate, streamed file by file.
// Written because the packaged runtime has no external zip tool available.
//
// usage: node make-zip.js <srcdir> <outZip>
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const [, , srcDir, outZip] = process.argv
const root = path.resolve(srcDir)

// --- CRC32 ------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function dosDateTime (date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xffff
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, day }
}

function collect (dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const name = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) collect(full, name, out)
    else if (entry.isFile()) out.push({ full, name })
  }
  return out
}

async function main () {
  const files = collect(root, '', [])
  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(f.full).size, 0)
  console.log(`archiving ${files.length} files, ${(totalBytes / 1048576).toFixed(1)} MiB`)

  const fd = fs.openSync(outZip, 'w')
  const central = []
  let offset = 0
  let done = 0
  let doneBytes = 0
  let lastLog = 0

  for (const file of files) {
    const stat = fs.statSync(file.full)
    const data = fs.readFileSync(file.full)
    // Deflate raw (no zlib header), the format ZIP expects.
    const deflated = zlib.deflateRawSync(data, { level: 6 })
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const { time, day } = dosDateTime(stat.mtime)
    const nameBuf = Buffer.from(file.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // version needed
    local.writeUInt16LE(0x0800, 6)    // UTF-8 filename flag
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    fs.writeSync(fd, local)
    fs.writeSync(fd, nameBuf)
    fs.writeSync(fd, payload)

    central.push({ nameBuf, method, time, day, crc, comp: payload.length, raw: data.length, offset })
    offset += local.length + nameBuf.length + payload.length

    done += 1
    doneBytes += data.length
    const now = Date.now()
    if (now - lastLog > 10000) {
      lastLog = now
      console.log(`  ${done}/${files.length} files, ${(doneBytes / 1048576).toFixed(0)} MiB read`)
    }
  }

  const centralStart = offset
  for (const e of central) {
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(e.method, 10)
    head.writeUInt16LE(e.time, 12)
    head.writeUInt16LE(e.day, 14)
    head.writeUInt32LE(e.crc, 16)
    head.writeUInt32LE(e.comp, 20)
    head.writeUInt32LE(e.raw, 24)
    head.writeUInt16LE(e.nameBuf.length, 28)
    head.writeUInt16LE(0, 30)
    head.writeUInt16LE(0, 32)
    head.writeUInt16LE(0, 34)
    head.writeUInt16LE(0, 36)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(e.offset, 42)
    fs.writeSync(fd, head)
    fs.writeSync(fd, e.nameBuf)
    offset += head.length + e.nameBuf.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  fs.writeSync(fd, end)
  fs.closeSync(fd)

  console.log(`wrote ${outZip} (${(fs.statSync(outZip).size / 1048576).toFixed(1)} MiB)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
