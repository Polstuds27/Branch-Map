/** Formats a Unix-seconds timestamp as a short relative age for graph rows. */
export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown date'

  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds
  if (deltaSeconds < 60) return 'just now'

  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ]

  let value = deltaSeconds
  let label = 'year'
  for (let i = 0; i < units.length; i += 1) {
    const [limit, name] = units[i]
    if (deltaSeconds < limit) break
    value = limit
    label = name
  }

  const count = Math.floor(deltaSeconds / value)
  return `${count} ${label}${count === 1 ? '' : 's'} ago`
}

/** Absolute local timestamp for the inspector. */
export function formatAbsolute(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown'
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}