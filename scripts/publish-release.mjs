/**
 * Publishes a finished build to GitHub Releases.
 *
 * electron-builder does the building; this does all of the publishing, and
 * deliberately so. Left to publish by itself it runs one uploader per artifact
 * in parallel, and each one, finding no release for the tag, creates its own —
 * so a build ended up split across two releases, one holding the installer and
 * the other its blockmap, and neither complete enough to update from.
 *
 * Here it happens once, in order: create, upload everything, then publish. The
 * release is a draft until the last step, so nothing is offered to anybody
 * until every file behind it is actually there.
 *
 * Needs GH_TOKEN — a token with `public_repo`, kept on the release machine.
 *
 *   npm run release:win     # build, then this
 *   node scripts/publish-release.mjs
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REPO = 'dixitchavada-1999/screen-recorder'

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  fail('GH_TOKEN is not set.', 'A GitHub token with `public_repo` is needed to publish.')
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tag = `v${version}`
const releaseDir = join(ROOT, 'release', version)

if (!existsSync(releaseDir)) {
  fail(`No build at release/${version}.`, 'Run `npm run build:win` first.')
}

/* -------------------------------------------------------------------------- */
/*                              What to upload                                */
/* -------------------------------------------------------------------------- */

const present = await readdir(releaseDir)

if (!present.includes('latest.yml')) {
  fail(
    `release/${version}/latest.yml is missing.`,
    'It is written by the NSIS target — build with `npm run build:win`.'
  )
}

/*
 * The manifest names the installer, so it decides what ships. Anything else in
 * the folder — the unpacked tree, builder-debug.yml — is build scaffolding and
 * stays behind.
 */
const manifest = readFileSync(join(releaseDir, 'latest.yml'), 'utf8')
const installers = [...manifest.matchAll(/url:\s*(.+\.exe)\s*$/gm)].map((m) => m[1].trim())

if (installers.length === 0) fail('latest.yml names no installer. The build looks incomplete.')

/*
 * The names in latest.yml are URL-safe — GitHub replaces spaces with hyphens on
 * upload — while the files on disk still have their spaces. Each asset is
 * therefore uploaded under the name the manifest expects, from the file that
 * actually exists.
 */
const uploads = []

for (const named of installers) {
  /*
   * Matched by turning each real filename into the name GitHub would give it,
   * rather than the other way round: the manifest name has spaces replaced by
   * hyphens, and a filename with hyphens of its own — `windows-x64` — cannot be
   * turned back into the original by undoing that.
   */
  const source =
    present.find((file) => file === named || file.replace(/ /g, '-') === named) ?? null

  if (!source) fail(`latest.yml names ${named}, but no such file is in release/${version}.`)

  uploads.push({ source, as: named })

  // Optional: lets a later update download only the parts that changed.
  const blockmap = `${source}.blockmap`
  if (present.includes(blockmap)) uploads.push({ source: blockmap, as: `${named}.blockmap` })
}

// Last, so the release is only announced once everything it points at is up.
uploads.push({ source: 'latest.yml', as: 'latest.yml' })

/* -------------------------------------------------------------------------- */
/*                                   GitHub                                   */
/* -------------------------------------------------------------------------- */

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) fail(`GitHub said ${response.status} for ${path}.`, JSON.stringify(body, null, 2))
  return body
}

const existing = (await api('/releases?per_page=30')).filter(
  (r) => r.tag_name === tag || r.name === tag
)

if (existing.some((r) => !r.draft)) {
  fail(
    `${tag} is already published.`,
    'Bump the version in package.json, or delete that release on github.com.'
  )
}

if (existing.length > 1) {
  fail(
    `${existing.length} drafts already exist for ${tag}.`,
    'Delete them on github.com and run this again.'
  )
}

/*
 * A draft, because a published release needs its tag to exist already and
 * nothing has created it yet — publishing the draft at the end is what does.
 */
const release =
  existing[0] ??
  (await api('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, draft: true })
  }))

console.log(`Publishing ${tag}\n`)

const alreadyUp = new Set((release.assets ?? []).map((a) => a.name))

for (const { source, as } of uploads) {
  if (alreadyUp.has(as)) {
    console.log(`  ${as.padEnd(46)} ${'already up'.padStart(11)}`)
    continue
  }

  const path = join(releaseDir, source)
  const size = statSync(path).size
  process.stdout.write(`  ${as.padEnd(46)} ${mb(size).padStart(11)}  … `)

  const response = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(as)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': as.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
        'Content-Length': String(size)
      },
      body: createReadStream(path),
      duplex: 'half'
    }
  )

  if (!response.ok) {
    console.log('failed')
    fail(`Upload of ${as} failed (${response.status}).`, await response.text())
  }

  console.log('done')
}

// Everything is up; this is the moment the release becomes real — and the
// moment GitHub creates the tag.
await api(`/releases/${release.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ draft: false, tag_name: tag, name: tag })
})

console.log(`\nPublished ${tag}.`)
console.log('Installed copies will be offered it on their next check.')

/* -------------------------------------------------------------------------- */

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fail(...lines) {
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(1)
}
