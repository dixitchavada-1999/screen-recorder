/**
 * Builds the browser extension's icons and the zip uploaded to the Chrome Web
 * Store and Edge Add-ons.
 *
 * The icons are the app's own, drawn at the four sizes the stores ask for. The
 * zip holds the manifest at its root, which is what both stores require.
 *
 * Run with: `npm run pack:extension`. Output: release/browser-extension-<version>.zip
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { iconPng } from './generate-icon.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'browser-extension')
const RELEASE = join(ROOT, 'release')

/* ---------------------------------- Icons --------------------------------- */

mkdirSync(join(SOURCE, 'icons'), { recursive: true })
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(SOURCE, 'icons', `icon-${size}.png`), iconPng(size))
}

/* --------------------------------- Checks --------------------------------- */

const manifest = JSON.parse(readFileSync(join(SOURCE, 'manifest.json'), 'utf8'))

for (const file of [manifest.background.service_worker, ...Object.values(manifest.icons)]) {
  statSync(join(SOURCE, file)) // throws, naming the file, if the manifest points at nothing
}

/* ----------------------------------- Zip ---------------------------------- */

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

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

/** A plain zip: deflated entries, a central directory, nothing else. */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(0, 10) // time and date: not recorded
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBytes, compressed)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}

const entries = filesUnder(SOURCE)
  .map((path) => ({ name: relative(SOURCE, path).split('\\').join('/'), data: readFileSync(path) }))
  .sort((a, b) => a.name.localeCompare(b.name))

mkdirSync(RELEASE, { recursive: true })
const output = join(RELEASE, `browser-extension-${manifest.version}.zip`)
writeFileSync(output, zip(entries))

console.log(`Wrote ${output}`)
for (const entry of entries) console.log(`  ${entry.name} (${entry.data.length} B)`)
