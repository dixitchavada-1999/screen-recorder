/**
 * Sets the password the uninstaller asks for.
 *
 * Asks for it twice without echoing it, then writes only a salted scrypt hash
 * to build/uninstall-password.json. That file is read when the app is built and
 * is git-ignored: the password itself is never stored anywhere, and the hash
 * stays off the repository.
 *
 * Run with: `npm run uninstall-password`, then build the installer. Running it
 * again replaces the password for every installer built afterwards; installers
 * already handed out keep the one they were built with.
 *
 * Remove the file to build installers that uninstall without a password.
 */

import { randomBytes, scryptSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'uninstall-password.json')

/** Must match electron/main/uninstall-guard.ts. */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LENGTH = 32

/** Reads one line from the terminal without showing what is typed. */
function ask(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY) {
      reject(new Error('Run this in a terminal, so the password can be typed without being shown.'))
      return
    }

    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')

    let value = ''
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false)
          input.pause()
          input.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    input.on('data', onData)
  })
}

const first = await ask('New uninstall password: ')
if (first.length < 8) {
  console.error('Use at least 8 characters.')
  process.exit(1)
}

const second = await ask('Type it again: ')
if (first !== second) {
  console.error('The two did not match. Nothing was changed.')
  process.exit(1)
}

const salt = randomBytes(16)
const hash = scryptSync(first, salt, KEY_LENGTH, PARAMS)

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }, null, 2))

console.log(`Saved. Installers built from now on ask for this password to uninstall.`)
console.log(`(${OUTPUT} holds only a hash, and is not committed.)`)
