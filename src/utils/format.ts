/** Pure formatting helpers shared across the UI. */

const pad = (value: number): string => String(value).padStart(2, '0')

/** Formats milliseconds as `HH:MM:SS` for the recording timer. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/** Formats a byte count using binary units, e.g. `1.4 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : 1

  return `${value.toFixed(decimals)} ${units[exponent]}`
}

/** Shortens a long filesystem path for display inside a fixed-width control. */
export function truncatePath(path: string, maxLength = 52): string {
  if (path.length <= maxLength) return path

  const separator = path.includes('\\') ? '\\' : '/'
  const segments = path.split(separator)
  const tail = segments.slice(-2).join(separator)

  return `${segments[0]}${separator}...${separator}${tail}`
}

/** Renders an epoch timestamp as a short local date and time. */
export function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })}`
}
