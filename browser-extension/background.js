/**
 * Browser activity, reported to the Screen Recorder desktop app on this machine.
 *
 * The extension never talks to the internet. It hands what it records to the
 * desktop app over 127.0.0.1, and the app decides everything else: whether the
 * signed-in person is tracked at all, whose account a visit belongs to, and when
 * it is uploaded. Until the app says recording is on, nothing is recorded.
 *
 * One visit is one page in the tab in front, in the focused window, while the
 * person is not idle — from when it came to the front to when something else
 * did. Switching tabs, loading a new address, leaving the browser, going idle
 * and closing the tab each end it.
 *
 * A service worker is stopped whenever the browser feels like it, so nothing is
 * kept in variables: the open visit lives in session storage and the queue in
 * local storage, and both survive the worker being woken again.
 */

import { describe, sameVisit } from './lib/visits.js'

const BRIDGE = 'http://127.0.0.1:39218'
const BROWSER = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'

/** A visit longer than this is cut and continued, so a long read still arrives in pieces. */
const MAX_VISIT_MS = 5 * 60_000

/**
 * No sign of life for this long means the browser or this worker was stopped —
 * the machine slept, the browser was closed. The open visit ends at the last
 * moment it was known to be true rather than absorbing the gap.
 */
const STALE_MS = 2 * 60_000

/** Visits held while the desktop app cannot be reached. Oldest go first past this. */
const MAX_QUEUE = 5000

/** Sent per request. */
const BATCH = 500

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

async function getState() {
  const { current = null, lastSeenAt = 0 } = await chrome.storage.session.get([
    'current',
    'lastSeenAt'
  ])
  return { current, lastSeenAt }
}

async function setCurrent(current) {
  await chrome.storage.session.set({ current, lastSeenAt: Date.now() })
}

async function touch() {
  await chrome.storage.session.set({ lastSeenAt: Date.now() })
}

async function getConfig() {
  const { config = null } = await chrome.storage.local.get('config')
  return config
}

/**
 * Events arrive in bursts — a tab switch fires three of them — and each handler
 * reads and writes the same state. Running them one after another is what keeps
 * a visit from being closed twice or opened over the top of another.
 */
let chain = Promise.resolve()
function serial(task) {
  chain = chain.then(task).catch((error) => console.warn('[browser-activity]', error))
  return chain
}

/* -------------------------------------------------------------------------- */
/*                                   Visits                                   */
/* -------------------------------------------------------------------------- */

const iso = (ms) => new Date(ms).toISOString()

/** Ends the open visit and queues it. One shorter than a second says nothing. */
async function closeCurrent(at = Date.now()) {
  const { current, lastSeenAt } = await getState()
  if (!current) return

  const end = lastSeenAt > 0 && at - lastSeenAt > STALE_MS ? lastSeenAt : at
  await chrome.storage.session.set({ current: null })

  if (end - current.startedAt < 1000) return

  await enqueue({
    ...current.visit,
    startedAt: iso(current.startedAt),
    endedAt: iso(end),
    browser: BROWSER
  })
}

/** Makes `tab` the open visit, or ends the open one when there is nothing to record. */
async function track(tab) {
  const config = await getConfig()
  const recording = config?.enabled === true

  const idle =
    recording &&
    (await chrome.idle.queryState(Math.max(15, config.idleAfterSeconds ?? 300))) !== 'active'

  const visit =
    recording && !idle && tab
      ? describe(tab.url || tab.pendingUrl, tab.title, config.excludedDomains ?? [])
      : null

  const { current } = await getState()

  // The same page still in front: carry on, keeping the latest title.
  if (current && visit && current.tabId === tab.id && sameVisit(current.visit, visit)) {
    if (visit.title) current.visit.title = visit.title
    await setCurrent(current)
    return
  }

  await closeCurrent()

  if (visit) await setCurrent({ tabId: tab.id, startedAt: Date.now(), visit })
  else await touch()
}

/** The tab in front of the focused browser window, or null when the browser is not focused. */
async function activeTab() {
  const window = await chrome.windows.getLastFocused().catch(() => null)
  if (!window || !window.focused) return null

  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
  return tab ?? null
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

chrome.tabs.onActivated.addListener(() => serial(async () => track(await activeTab())))

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.active || !('url' in change || 'title' in change)) return
  serial(async () => {
    const front = await activeTab()
    if (front && front.id === tabId) await track(front)
  })
})

chrome.tabs.onRemoved.addListener((tabId) =>
  serial(async () => {
    const { current } = await getState()
    if (current?.tabId === tabId) await closeCurrent()
    await track(await activeTab())
  })
)

chrome.windows.onFocusChanged.addListener((windowId) =>
  serial(async () =>
    windowId === chrome.windows.WINDOW_ID_NONE ? closeCurrent() : track(await activeTab())
  )
)

chrome.idle.onStateChanged.addListener((state) =>
  serial(async () => (state === 'active' ? track(await activeTab()) : closeCurrent()))
)

/*
 * The heartbeat. Every half minute: ask the app what to do, end a visit the
 * worker slept through, cut one that has run long, and send what is queued.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'tick') return
  serial(async () => {
    await refreshConfig()

    const { current, lastSeenAt } = await getState()
    if (current) {
      if (Date.now() - lastSeenAt > STALE_MS) await closeCurrent()
      else if (Date.now() - current.startedAt >= MAX_VISIT_MS) await closeCurrent()
    }

    await track(await activeTab())
    await flush()
  })
})

function start() {
  chrome.alarms.create('tick', { periodInMinutes: 0.5 })
  serial(async () => {
    await refreshConfig()
    await track(await activeTab())
  })
}

chrome.runtime.onInstalled.addListener(start)
chrome.runtime.onStartup.addListener(start)

/* -------------------------------------------------------------------------- */
/*                           Talking to the desktop app                        */
/* -------------------------------------------------------------------------- */

async function request(path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    return await fetch(`${BRIDGE}${path}`, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What the app says to do. Kept as it was when the app cannot be reached — it
 * may simply not have started yet — but recording stops, and everything held
 * is thrown away, the moment it answers "off".
 */
async function refreshConfig() {
  let config
  try {
    const response = await request('/v1/config')
    if (!response.ok) return
    config = await response.json()
  } catch {
    return
  }

  const next = {
    enabled: config.enabled === true,
    excludedDomains: Array.isArray(config.excludedDomains) ? config.excludedDomains : [],
    idleAfterSeconds: Number(config.idleAfterSeconds) || 300,
    fetchedAt: Date.now()
  }

  await chrome.storage.local.set({ config: next })
  chrome.idle.setDetectionInterval(Math.max(15, next.idleAfterSeconds))

  if (!next.enabled) {
    await chrome.storage.session.set({ current: null })
    await chrome.storage.local.set({ queue: [] })
  }
}

async function enqueue(visit) {
  const { queue = [] } = await chrome.storage.local.get('queue')
  queue.push(visit)
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
  await chrome.storage.local.set({ queue })
}

/** Sends the queue, oldest first. Whatever is not confirmed stays for the next tick. */
async function flush() {
  const { queue = [] } = await chrome.storage.local.get('queue')
  if (queue.length === 0) return

  const batch = queue.slice(0, BATCH)

  try {
    const response = await request('/v1/visits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visits: batch })
    })
    if (!response.ok) return
  } catch {
    return
  }

  // Re-read: visits may have been queued while the request was out.
  const { queue: latest = [] } = await chrome.storage.local.get('queue')
  await chrome.storage.local.set({ queue: latest.slice(batch.length) })
}
