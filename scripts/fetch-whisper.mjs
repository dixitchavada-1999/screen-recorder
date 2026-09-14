/**
 * Puts the whisper.cpp binaries in `whisper/`, ready for electron-builder.
 *
 * They are not in the repository, for the same reason the FFmpeg binary is not:
 * ten megabytes of platform-specific DLLs are a build input, not source. This
 * runs before a packaged build, so a fresh clone produces the same installer as
 * the machine that has been building all along.
 *
 * Does nothing when the folder already looks complete, so the ordinary rebuild
 * costs one `existsSync` rather than a download.
 *
 *   node scripts/fetch-whisper.mjs          # fetch if missing
 *   node scripts/fetch-whisper.mjs --force  # fetch again regardless
 *
 * Only the files whisper.cpp actually needs to transcribe are kept. The release
 * archive also carries a server, a benchmark, an SDL-based live-stream demo and
 * several test programs — none of which this app ever spawns.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { copyFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const DESTINATION = join(ROOT, 'whisper')
const RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'

/**
 * Which archive each platform needs.
 *
 * Windows takes the plain CPU build rather than the BLAS one: the BLAS archive
 * is another forty-nine megabytes, almost all of it `libopenblas.dll`, for a
 * gain that barely shows against ggml's own AVX2/AVX-512 kernels. The CUDA
 * builds are larger still and useless without an NVIDIA card.
 */
const ARCHIVES = {
  win32: 'whisper-bin-x64.zip',
  linux: 'whisper-bin-ubuntu-x64.tar.gz'
}

/** The executable, the library, and the backends ggml picks between at runtime. */
const KEEP = /^(whisper-cli(\.exe)?|whisper\.dll|libwhisper.*|ggml\.dll|ggml-base\.dll|ggml-cpu-.*\.(dll|so)|libggml.*)$/

const force = process.argv.includes('--force')
const archive = ARCHIVES[process.platform]

if (!archive) {
  console.log(`whisper.cpp: no published build for ${process.platform}, skipping.`)
  process.exit(0)
}

if (!force && looksComplete()) {
  console.log('whisper.cpp: already in whisper/, skipping.')
  process.exit(0)
}

const scratch = join(tmpdir(), `whisper-fetch-${Date.now()}`)
mkdirSync(scratch, { recursive: true })

try {
  const url = await findAsset(archive)
  console.log(`whisper.cpp: fetching ${archive}`)

  const downloaded = join(scratch, archive)
  await download(url, downloaded)
  extract(downloaded, scratch)

  mkdirSync(DESTINATION, { recursive: true })
  const copied = await keepWhatIsNeeded(scratch, DESTINATION)

  if (copied === 0) fail('The archive held none of the expected files.')
  console.log(`whisper.cpp: ${copied} files in whisper/`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

/* -------------------------------------------------------------------------- */

function looksComplete() {
  const binary = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return existsSync(join(DESTINATION, binary))
}

async function findAsset(name) {
  const response = await fetch(RELEASES, {
    headers: {
      accept: 'application/vnd.github+json',
      // Unauthenticated calls are rate limited per address; a token lifts it
      // where CI has one, and its absence is not an error.
      ...(process.env.GH_TOKEN ? { authorization: `token ${process.env.GH_TOKEN}` } : {})
    }
  })

  if (!response.ok) fail(`GitHub said ${response.status} asking for the latest release.`)

  const release = await response.json()
  const asset = (release.assets ?? []).find((item) => item.name === name)

  if (!asset) fail(`${name} is not in release ${release.tag_name}.`)

  console.log(`whisper.cpp: release ${release.tag_name}`)
  return asset.browser_download_url
}

async function download(url, to) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) fail(`Download failed (${response.status}).`)

  const partial = `${to}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))

  const expected = Number(response.headers.get('content-length') ?? 0)
  if (expected > 0 && statSync(partial).size !== expected) {
    await rm(partial, { force: true })
    fail('The download was cut short.')
  }

  await rename(partial, to)
}

/**
 * Unpacks the archive, working around two separate `tar` problems on Windows.
 *
 * Windows has shipped bsdtar as `System32\tar.exe` since 2018, and it reads zip
 * archives. GNU tar does not — and GNU tar is what a Git Bash shell puts on PATH
 * ahead of it, so `tar -xf whisper.zip` there fails with "This does not look
 * like a tar archive". The system one is therefore named outright rather than
 * left to PATH.
 *
 * It is also run from inside the target directory with a bare filename: given
 * `-f C:\...`, GNU tar reads the leading `C:` as `host:path` and tries to open
 * an rsh connection. No colon, no ambiguity, in either tar.
 */
function extract(archivePath, into) {
  const systemTar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
  const tar = process.platform === 'win32' && existsSync(systemTar) ? systemTar : 'tar'

  const flags = archivePath.endsWith('.zip') ? '-xf' : '-xzf'
  execFileSync(tar, [flags, basename(archivePath)], { cwd: into, stdio: 'inherit' })
}

/** Walks the extracted tree and copies the files that matter, flattened. */
async function keepWhatIsNeeded(from, to) {
  let copied = 0

  const walk = async (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(path)
        continue
      }

      if (!KEEP.test(entry.name)) continue

      await copyFile(path, join(to, entry.name))
      copied += 1
    }
  }

  await walk(from)
  return copied
}

function fail(message) {
  console.error(`\nwhisper.cpp: ${message}\n`)
  process.exit(1)
}
