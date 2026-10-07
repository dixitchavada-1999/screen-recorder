/**
 * Turning a tab into a visit record.
 *
 * Pure functions only — no `chrome.*` — so the rules about what is recorded can
 * be read and tested on their own. Everything that leaves the browser passes
 * through `describe` first.
 */

/** Longest address and title kept; the server refuses anything longer. */
const MAX_URL = 2048
const MAX_TITLE = 500
const MAX_QUERY = 500

/**
 * The search engines whose results pages are recognised, and where each one
 * keeps the query. Matched on the host (any country domain for Google) and the
 * path, so a page that merely has a `q` parameter is not mistaken for a search.
 */
const SEARCH_ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)bing\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: 'q' },
  { host: /(^|\.)search\.yahoo\.com$/, path: /^\/search/, param: 'p' },
  { host: /(^|\.)yandex\.[a-z.]+$/, path: /^\/search/, param: 'text' },
  { host: /(^|\.)youtube\.com$/, path: /^\/results/, param: 'search_query' },
  { host: /(^|\.)github\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)amazon\.[a-z.]+$/, path: /^\/s$/, param: 'k' },
  { host: /(^|\.)stackoverflow\.com$/, path: /^\/search/, param: 'q' }
]

/** The browser's own new tab page, in each of its spellings. */
const NEW_TAB = /^(chrome|edge):\/\/(newtab|new-tab-page)\/?|^chrome-search:\/\/local-ntp|^about:newtab/

/**
 * What one tab amounts to as a visit, or null when it is not one worth
 * recording — the browser's settings, an extension page, a blank tab.
 *
 * `excludedDomains` are matched with their subdomains: excluding `hdfcbank.com`
 * covers `netbanking.hdfcbank.com`. An excluded site keeps only its name — no
 * address, no title, no search.
 */
export function describe(url, title, excludedDomains = []) {
  if (typeof url !== 'string' || url.length === 0) return null

  if (NEW_TAB.test(url)) {
    return { domain: 'newtab', url: null, title: 'New Tab', search: null, excluded: false }
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return null

  const excludedAs = matchExcluded(host, excludedDomains)
  if (excludedAs) {
    return { domain: excludedAs, url: null, title: null, search: null, excluded: true }
  }

  // The fragment is page state, not an address; dropping it keeps one page one entry.
  parsed.hash = ''

  return {
    domain: host.slice(0, 255),
    url: parsed.toString().slice(0, MAX_URL),
    title: cleanTitle(title),
    search: searchQuery(parsed),
    excluded: false
  }
}

/** The search typed into a results page, or null when the page is not one. */
export function searchQuery(parsed) {
  const host = parsed.hostname.toLowerCase()

  for (const engine of SEARCH_ENGINES) {
    if (!engine.host.test(host) || !engine.path.test(parsed.pathname)) continue

    const query = (parsed.searchParams.get(engine.param) ?? '').replace(/\s+/g, ' ').trim()
    return query ? query.slice(0, MAX_QUERY) : null
  }

  return null
}

/** The excluded entry a host falls under, or null. */
export function matchExcluded(host, excludedDomains) {
  for (const raw of excludedDomains) {
    const domain = String(raw).toLowerCase().trim().replace(/^www\./, '')
    if (!domain) continue
    if (host === domain || host.endsWith(`.${domain}`)) return domain
  }
  return null
}

function cleanTitle(title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, MAX_TITLE) : null
}

/** Two descriptions are the same visit when nothing a reader would see changed. */
export function sameVisit(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.domain === b.domain &&
    a.url === b.url &&
    a.excluded === b.excluded
  )
}
