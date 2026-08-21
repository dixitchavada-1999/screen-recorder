/**
 * Joins conditional class names.
 *
 * Deliberately dependency-free — the project has no need for the full
 * `clsx`/`tailwind-merge` pair, and every byte counts in a desktop bundle.
 */
export type ClassValue = string | number | false | null | undefined

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}
