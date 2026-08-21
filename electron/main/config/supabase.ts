/**
 * Supabase connection details.
 *
 * The anon key is *meant* to be public — it identifies the project, it does not
 * grant anything. Every table this app touches has row level security on, so a
 * request carrying only the anon key can read nothing but its own rows. Shipping
 * it inside the app is the intended design.
 *
 * The `service_role` key is the opposite: it bypasses row level security
 * entirely. It must never appear in this file, in the renderer, or anywhere else
 * that gets packaged — it belongs on a server you control, or nowhere.
 *
 * The environment variables exist so a developer can point a local build at
 * another project without editing the file.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://xnppcykubshfkrxvchgt.supabase.co'

export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhucHBjeWt1YnNoZmtyeHZjaGd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzUyNTYsImV4cCI6MjEwMTI1MTI1Nn0.KZl1ADAWPc1vm3z1e3hhv31KzdULkkDmD80dL-Koass'

/** False when the app was built without a project, which disables the account UI. */
export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}
