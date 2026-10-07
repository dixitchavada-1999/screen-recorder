/**
 * The browser extension that reports tabs and searches, and how it reaches the app.
 *
 * The extension lives in `browser-extension/` and is published to the Chrome
 * Web Store (unlisted) and Edge Add-ons. Each store assigns its own id when the
 * extension is first uploaded; paste them here and rebuild. Until then:
 *
 *   - the bridge accepts any extension origin, so the unpacked extension can be
 *     tested from `chrome://extensions`;
 *   - nothing is written to the browsers' install policy, because there is no
 *     published extension for it to install.
 */

/** The port the app listens on for the extension. Fixed: the extension cannot be told another. */
export const BRIDGE_PORT = 39218

/** The Chrome Web Store id, 32 letters a–p. Empty until published. */
export const CHROME_EXTENSION_ID = process.env.CHROME_EXTENSION_ID ?? ''

/** The Edge Add-ons id. Empty until published. */
export const EDGE_EXTENSION_ID = process.env.EDGE_EXTENSION_ID ?? ''

/** Where each browser fetches a store extension and its updates from. */
export const CHROME_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'
export const EDGE_UPDATE_URL = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'

/** Origins the bridge answers. Empty means "any extension", for testing before publishing. */
export function allowedOrigins(): string[] {
  return [CHROME_EXTENSION_ID, EDGE_EXTENSION_ID]
    .filter((id) => /^[a-p]{32}$/.test(id))
    .map((id) => `chrome-extension://${id}`)
}
