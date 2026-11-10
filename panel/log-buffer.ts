import type { LogAnswer, LogLine, LogTarget } from '../src/protocol'
import { timeKey } from '../src/log-time'

const identity = (line: LogLine) => JSON.stringify([line.containerId, line.src, line.t, line.e, line.m])

export class LogBuffer {
  lines: LogLine[] = []
  clearedAt: string | null = null
  truncated = false
  limits = new Set<string>()
  errors: LogAnswer['errors'] = []
  private cursors = new Map<string, string>()
  private boundaries = new Map<string, Map<string, number>>()
  reset(): void {
    this.lines = []; this.clearedAt = null; this.truncated = false; this.limits.clear(); this.errors = []; this.cursors.clear(); this.boundaries.clear()
  }
  targets(targets: LogTarget[]): LogTarget[] {
    return targets.map((target) => ({ ...target, ...(this.cursors.has(target.containerId) ? { cursor: this.cursors.get(target.containerId) } : {}) }))
  }
  apply(answer: LogAnswer, targets: LogTarget[], incremental: boolean, tail: boolean): void {
    if (!incremental || this.clearedAt !== answer.clearedAt) this.reset()
    this.clearedAt = answer.clearedAt
    this.errors = answer.errors
    this.truncated ||= answer.truncated
    for (const limit of answer.limits) this.limits.add(limit)
    // Inclusive overlap must outlive rendered history: a full boundary timestamp must not
    // reinsert lines evicted by the display limit on every subsequent poll.
    const seen = new Map<string, Map<string, number>>()
    const fresh = answer.lines.filter((line) => {
      const id = line.containerId
      if (!id || !line.t) return true
      const previous = this.cursors.get(id)
      const counts = seen.get(id) ?? new Map<string, number>()
      seen.set(id, counts)
      const key = identity(line)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return !previous || timeKey(line.t) > timeKey(previous) ||
        (timeKey(line.t) === timeKey(previous) && counts.get(key)! > (this.boundaries.get(id)?.get(key) ?? 0))
    })
    for (const line of answer.lines) {
      const id = line.containerId
      if (!id || !line.t) continue
      const previous = this.cursors.get(id)
      if (!previous || timeKey(line.t) > timeKey(previous)) { this.cursors.set(id, line.t); this.boundaries.set(id, new Map()) }
    }
    for (const line of answer.lines) {
      const id = line.containerId
      if (!id || timeKey(line.t) !== timeKey(this.cursors.get(id) ?? '')) continue
      const key = identity(line)
      const counts = this.boundaries.get(id) ?? new Map<string, number>()
      this.boundaries.set(id, counts)
      counts.set(key, Math.max(counts.get(key) ?? 0, seen.get(id)?.get(key) ?? 0))
    }
    const active = new Map(targets.map((t) => [t.containerId, t]))
    this.lines = [...this.lines, ...fresh].sort((a, b) => timeKey(a.t).localeCompare(timeKey(b.t))).filter((line) => {
      if (!line.containerId) return true
      if (!active.has(line.containerId)) return false
      const target = active.get(line.containerId)!
      return (!target.since || timeKey(line.t) >= timeKey(target.since)) && (!target.until || timeKey(line.t) <= timeKey(target.until))
    })
    let chars = 0
    let start = this.lines.length
    const maxLines = tail ? 1000 : 10_000
    while (start > 0 && this.lines.length - start < maxLines) {
      chars += this.lines[start - 1].m.length + 200
      if (chars > 1_800_000) break
      start--
    }
    if (start) { this.lines = this.lines.slice(start); this.truncated = true; this.limits.add('buffer') }
    for (const id of this.cursors.keys()) if (!active.has(id)) { this.cursors.delete(id); this.boundaries.delete(id) }
  }
}
