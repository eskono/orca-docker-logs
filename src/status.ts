// What the status bar item says about a project, and which container problems are worth a notification.
import type { ServiceRow } from './protocol'

/** Clean exit or a graceful interrupt/termination; SIGKILL alone is not evidence of an intentional stop. */
const STOPPED_CODES = new Set([0, 130, 143])

/** A short phrase for what is wrong with a container, or null when nothing is. */
export function problemOf(row: ServiceRow): string | null {
  if (row.state === 'exited' && row.oomKilled) return 'was killed (out of memory)'
  if (row.stateError) return `failed: ${row.stateError}`
  if (row.state === 'dead') return 'died'
  if (row.state === 'restarting') return 'keeps restarting'
  if (row.state === 'exited' && row.exitCode !== null && !STOPPED_CODES.has(row.exitCode)) {
    return `exited with code ${row.exitCode}`
  }
  if (row.state === 'running' && row.health === 'unhealthy') return 'is unhealthy'
  return null
}

export type StatusSummary = { text: string; tone: 'neutral' | 'success' | 'danger'; tooltip: string }

/** `running/total`; services of inactive profiles that never ran do not count. */
export function summarize(project: string, rows: ServiceRow[]): StatusSummary {
  const counted = rows.filter((r) => r.containerId !== null || r.profiles.length === 0)
  const running = counted.filter((r) => r.state === 'running').length
  const problems = rows.flatMap((r) => {
    const problem = problemOf(r)
    return problem ? [`${r.name} ${problem}`] : []
  })
  const tone = problems.length ? 'danger' : running > 0 && running === counted.length ? 'success' : 'neutral'
  const tooltip = [`${project}: ${running} of ${counted.length} running`, ...problems].join('\n')
  return { text: `${running}/${counted.length}`, tone, tooltip }
}

/** Do not repeat a notification for the same container and problem within this time. */
export const NOTIFY_COOLDOWN_MS = 10 * 60_000

/**
 * Tracks container problems between polls of one project and reports those that just appeared.
 * The first poll only records what is already wrong, so opening a project does not notify.
 */
export class ProblemTracker {
  private active = new Set<string>()
  private lastNotified = new Map<string, number>()
  private seeded = false
  private restarts = new Map<string, number>()

  /** Forget the previous project's state (its first poll is a baseline again). */
  reset(): void {
    this.active = new Set()
    this.seeded = false
    this.restarts.clear()
  }

  /** Rows whose problem is new since the last poll and was not notified recently. */
  update(rows: ServiceRow[], now: number): { row: ServiceRow; problem: string }[] {
    const current = new Set<string>()
    const fresh: { row: ServiceRow; problem: string }[] = []
    for (const row of rows) {
      const previous = row.containerId ? this.restarts.get(row.containerId) : undefined
      if (row.containerId) this.restarts.set(row.containerId, row.restartCount)
      const problem = problemOf(row) ?? (previous !== undefined && row.restartCount > previous ? 'restarted unexpectedly' : null)
      if (!problem || !row.containerId) continue
      const key = `${row.containerId}:${problem}`
      current.add(key)
      const recently = now - (this.lastNotified.get(key) ?? -Infinity) < NOTIFY_COOLDOWN_MS
      if (this.seeded && !this.active.has(key) && !recently) {
        this.lastNotified.set(key, now)
        fresh.push({ row, problem })
      }
    }
    this.active = current
    const present = new Set(rows.map((r) => r.containerId))
    for (const id of this.restarts.keys()) if (!present.has(id)) this.restarts.delete(id)
    for (const [key, at] of this.lastNotified) if (now - at > NOTIFY_COOLDOWN_MS) this.lastNotified.delete(key)
    this.seeded = true
    return fresh
  }
}
