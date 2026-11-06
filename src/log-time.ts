/** Compare RFC3339 UTC timestamps without discarding Docker's nanoseconds. */
export function timeKey(time: string): string {
  return time.replace(/(?:\.(\d+))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(9, '0')}Z`)
}

export function latestTime(...times: (string | null | undefined)[]): string | null {
  return times.reduce<string | null>((a, b) => b && (!a || timeKey(b) > timeKey(a)) ? b : a, null)
}
