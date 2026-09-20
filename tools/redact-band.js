'use strict'
// Redact a horizontal band of an image by compositing a blurred, averaged strip
// over it. Used to scrub local filesystem paths out of documentation screenshots.
//
// usage: node redact-band.js <in.png> <out.png> <x> <y> <w> <h> [sigma]
const fs = require('node:fs')
const sharp = require('sharp')

const [input, output, xs, ys, ws, hs, sigmas] = process.argv.slice(2)
const x = Number(xs)
const y = Number(ys)
const w = Number(ws)
const h = Number(hs)
const sigma = Number(sigmas || 14)

async function main () {
  const src = sharp(input)
  const meta = await src.metadata()

  // Feather the band a little so its edges do not read as a hard rectangle.
  const pad = 2
  const left = Math.max(0, x - pad)
  const top = Math.max(0, y - pad)
  const width = Math.min(meta.width - left, w + pad * 2)
  const height = Math.min(meta.height - top, h + pad * 2)

  const patch = await sharp(input)
    .extract({ left, top, width, height })
    .blur(sigma)
    .toBuffer()

  await sharp(input)
    .composite([{ input: patch, left, top, blend: 'over' }])
    .png()
    .toFile(output)

  console.log(`redacted ${w}x${h} at (${x},${y}) sigma=${sigma} -> ${output}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
