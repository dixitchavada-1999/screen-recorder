import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { logger } from '../lib/logger'

const SCOPE = 'device'

/**
 * Which machine this is.
 *
 * One person having two machines is ordinary — a desk and a laptop — and until
 * now nothing recorded which of them a day came from. Worse, the unique keys on
 * the activity tables assumed there was only one, so two machines working the
 * same minutes would collide and the second one's rows were quietly dropped.
 *
 * The id is generated here and means nothing outside this app: it is a random
 * uuid, not a serial number, a MAC address or anything else that identifies the
 * hardware or would follow the person to another product. Reinstalling the app
 * with its data removed produces a new one, and that is the correct answer —
 * it is a fresh installation.
 */

const FILE = 'device.json'

interface Stored {
  machineId: string
}

/** What the login request carries. */
export interface DeviceIdentity {
  machineId: string
  hostname: string
  platform: string
  appVersion: string
}

let machineId: string | null = null

/**
 * The server's id for this machine, learned at sign-in.
 *
 * Null until somebody signs in, and null again if registration failed — which
 * is not fatal: rows are filed without it and the unique indexes are built to
 * tolerate that.
 */
let deviceId: string | null = null

function path(): string {
  return join(app.getPath('userData'), FILE)
}

/**
 * The stable id for this installation, generating one on first use.
 *
 * Read through a cache: this is asked for on every sign-in and every upload
 * pass, and none of those should touch the disk.
 */
export async function getMachineId(): Promise<string> {
  if (machineId !== null) return machineId

  try {
    const parsed = JSON.parse(await readFile(path(), 'utf8')) as Stored
    if (typeof parsed.machineId === 'string' && parsed.machineId.length > 0) {
      machineId = parsed.machineId
      return machineId
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing is the normal first run. Anything else is worth a line, but the
    // answer is the same either way: make one.
    if (code !== 'ENOENT') logger.warn(SCOPE, 'Could not read the device id', error)
  }

  machineId = randomUUID()

  try {
    await writeFile(path(), JSON.stringify({ machineId } satisfies Stored), 'utf8')
    logger.info(SCOPE, 'Registered this installation')
  } catch (error) {
    // A new id every launch is bad — it would litter the devices table — but it
    // is still better than refusing to sign in.
    logger.warn(SCOPE, 'Could not store the device id', error)
  }

  return machineId
}

/** Everything the login request tells the server about this machine. */
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  return {
    machineId: await getMachineId(),
    hostname: safeHostname(),
    platform: process.platform,
    appVersion: app.getVersion()
  }
}

/** Records what the server called this machine. */
export function setDeviceId(id: string | null): void {
  deviceId = id
  if (id) logger.debug(SCOPE, 'Device registered', { deviceId: id })
}

/**
 * The server's device id, or null.
 *
 * Everything the tracker writes carries it, so a day can be read per machine
 * rather than as one merged timeline that belongs to nobody in particular.
 */
export function currentDeviceId(): string | null {
  return deviceId
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}
