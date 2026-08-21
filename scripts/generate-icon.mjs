/**
 * Generates the build's image assets:
 *
 *  - `build/icon.png`             the application icon used by electron-builder
 *  - `build/trayTemplate.png`     the macOS menu-bar icon (and its @2x variant)
 *
 * Everything is drawn procedurally and encoded as a PNG with Node's built-in
 * zlib, so the repository carries no binary asset and the build has no extra
 * dependency. Run with: `node scripts/generate-icon.mjs`
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const OUTPUT = join(BUILD_DIR, 'icon.png')

/* ------------------------------- Drawing ---------------------------------- */

const rgba = (r, g, b, a = 255) => ({ r, g, b, a })

const BACKGROUND_TOP = rgba(99, 102, 241) // indigo
const BACKGROUND_BOTTOM = rgba(59, 47, 158)
const RING = rgba(238, 242, 255)
const DOT = rgba(239, 68, 68) // record red

/** Linear interpolation between two colours. */
const mix = (a, b, t) => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
  a: Math.round(a.a + (b.a - a.a) * t)
})

/** Signed distance to a rounded rectangle, used for the app tile shape. */
function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - halfWidth + radius
  const dy = Math.abs(y) - halfHeight + radius
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** Antialiasing coverage from a signed distance (1 inside, 0 outside). */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance))

function drawPixel(x, y) {
  // Centre the coordinate system on the canvas.
  const cx = x - SIZE / 2 + 0.5
  const cy = y - SIZE / 2 + 0.5

  const tileAlpha = coverage(roundedRectDistance(cx, cy, 232, 232, 112))
  if (tileAlpha <= 0) return rgba(0, 0, 0, 0)

  // Vertical gradient background.
  let colour = mix(BACKGROUND_TOP, BACKGROUND_BOTTOM, y / SIZE)

  // Outer ring of the record symbol.
  const distanceFromCentre = Math.hypot(cx, cy)
  const ringAlpha =
    coverage(distanceFromCentre - 150) * (1 - coverage(distanceFromCentre - 124))
  colour = mix(colour, RING, ringAlpha)

  // Solid record dot.
  colour = mix(colour, DOT, coverage(distanceFromCentre - 86))

  return { ...colour, a: Math.round(255 * tileAlpha) }
}

/* -------------------------------- Encoding -------------------------------- */

/** Builds the raw scanline buffer: one filter byte per row, then RGBA pixels. */
function buildRaster(size = SIZE, paint = drawPixel) {
  const raster = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0

  for (let y = 0; y < size; y += 1) {
    raster[offset] = 0 // filter type: None
    offset += 1

    for (let x = 0; x < size; x += 1) {
      const { r, g, b, a } = paint(x, y, size)
      raster[offset] = r
      raster[offset + 1] = g
      raster[offset + 2] = b
      raster[offset + 3] = a
      offset += 4
    }
  }

  return raster
}

/** CRC-32, required by every PNG chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))

  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(raster, size = SIZE) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0) // width
  header.writeUInt32BE(size, 4) // height
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // compression: deflate
  header[11] = 0 // filter method
  header[12] = 0 // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raster, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------ Tray template ------------------------------ */

/**
 * The macOS menu-bar glyph.
 *
 * A template image is pure black plus an alpha channel — macOS derives the
 * light and dark menu-bar appearances from the alpha itself, which is why the
 * colourful app icon cannot be reused here: it would come out as a muddy blob
 * that ignores the user's appearance setting. The record ring is drawn open
 * rather than filled so it stays legible at 16 px.
 */
function drawTrayPixel(x, y, size) {
  const scale = size / 16
  const cx = x - size / 2 + 0.5
  const cy = y - size / 2 + 0.5

  const distance = Math.hypot(cx, cy) / scale

  // Outer ring (radius 6.6, one pixel thick) and the solid centre dot.
  const ring = coverage(distance - 6.6) * (1 - coverage(distance - 5.4))
  const dot = coverage(distance - 3)

  const alpha = Math.min(1, ring + dot)
  return { r: 0, g: 0, b: 0, a: Math.round(255 * alpha) }
}

function writeTrayIcon(fileName, size) {
  const png = encodePng(buildRaster(size, drawTrayPixel), size)
  const path = join(BUILD_DIR, fileName)
  writeFileSync(path, png)
  console.log(`Wrote ${path} (${size}x${size}, ${(png.length / 1024).toFixed(1)} kB)`)
}

/* --------------------------------- Main ----------------------------------- */

mkdirSync(BUILD_DIR, { recursive: true })

const png = encodePng(buildRaster())
writeFileSync(OUTPUT, png)
console.log(`Wrote ${OUTPUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`)

// `nativeImage` picks the @2x file up automatically on Retina displays, and the
// "Template" suffix is what marks the image as tintable to macOS.
writeTrayIcon('trayTemplate.png', 16)
writeTrayIcon('trayTemplate@2x.png', 32)
