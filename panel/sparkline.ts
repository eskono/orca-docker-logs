// Numbers from `docker stats` text, and the points of a small line chart.

/** `3.34%` → 3.34. */
export function parsePercent(text: string): number | null {
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : null
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4
}

/** `323.5MiB` → bytes; docker prints binary units for memory. */
export function parseBytes(text: string): number | null {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim())
  const unit = match ? UNITS[match[2].toLowerCase()] : undefined
  return match && unit ? Number.parseFloat(match[1]) * unit : null
}

/**
 * SVG polyline points for `values` in a `width`×`height` box, 0 at the bottom and `max` at the top.
 * The newest value is at the right edge; fewer samples than slots leave the left side empty.
 */
export function sparkPoints(values: number[], slots: number, width: number, height: number, max: number): string {
  const step = width / Math.max(1, slots - 1)
  const offset = (slots - values.length) * step
  return values
    .map((value, i) => {
      const x = offset + i * step
      const y = height - (Math.min(value, max) / max) * (height - 1) - 0.5
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
