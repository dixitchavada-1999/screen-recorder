/**
 * Values fixed when the main process is built (see electron.vite.config.ts).
 */

/**
 * The salted hash the uninstaller's password is checked against, from
 * build/uninstall-password.json. Both empty when no password was set.
 */
declare const __UNINSTALL_PASSWORD__: { salt: string; hash: string }
