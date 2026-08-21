/**
 * The app's own URL scheme.
 *
 * Supabase sends confirmation and recovery links by email, and the browser that
 * opens them has to hand the result back to a desktop app that owns no website.
 * A registered scheme is how that happens: the OS matches `screenrecorder://`
 * to this app and passes the whole URL to it.
 *
 * Whatever is used here must also be listed under
 * Authentication → URL Configuration → Redirect URLs in the Supabase dashboard,
 * or the link will bounce to the project's Site URL instead.
 */
export const PROTOCOL_SCHEME = 'screenrecorder'

/** Where Supabase should send the browser after an email link is opened. */
export const AUTH_CALLBACK_URL = `${PROTOCOL_SCHEME}://auth/callback`
