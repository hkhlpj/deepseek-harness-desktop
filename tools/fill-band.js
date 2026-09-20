'use strict'
// Paint an opaque, flat rectangle over a region of an image.
//
// usage: node fill-band.js <in.png> <out.png> <x> <y> <w> <h> <color>
const sharp = require('sharp')

const [input, output, xs, ys, ws, hs, color] = process.argv.slice(2)
const x = Number(xs)
const y = Number(ys)
const w = Number(ws)
const h = Number(hs)

async function main () {
  const meta = await sharp(input).metadata()
  const left = Math.max(0, Math.min(x, meta.width - 1))
  const top = Math.max(0, Math.min(y, meta.height - 1))
  const width = Math.max(1, Math.min(w, meta.width - left))
  const height = Math.max(1, Math.min(h, meta.height - top))

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="${color || '#ffffff'}"/>
  </svg>`

  await sharp(input)
    .composite([{ input: Buffer.from(svg), left, top, blend: 'over' }])
    .png()
    .toFile(output)

  console.log(`filled ${width}x${height} at (${left},${top}) with ${color || '#ffffff'} -> ${output}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
