import { createHash, randomUUID } from 'node:crypto'
import { fail, shellQuote } from './docker'
import type { Operation } from './protocol'

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
type ReadTerminal = (id: string) => Promise<{ lines: string[]; truncated: boolean }>
const storageKey = (path: string) => `operations:${createHash('sha256').update(path).digest('hex')}`
export const operationMarker = (id: string) => `ORCA_DOCKER_DONE_${id.replace(/-/g, '')}`

export function trackedCommand(command: string, id: string): string {
  const marker = operationMarker(id)
  const trap = [ ['HUP', 129], ['INT', 130], ['TERM', 143] ].map(([signal, code]) =>
    `trap ${shellQuote(`printf '\\n${marker} ${code}\\n'; exit ${code}`)} ${signal}`
  ).join('; ')
  return `sh -c ${shellQuote(`${trap}; ${command}; orca_docker_result=$?; printf '\\n${marker} %s\\n' "$orca_docker_result"; exit "$orca_docker_result"`)}`
}

function tail(lines: string[]): string[] {
  return lines.join('\n').slice(-2000).split('\n').slice(-40)
}

/** Commands keep running in their own Orca terminals through panel/worker reloads. */
export class Operations {
  private records = new Map<string, Operation[]>()
  private loading = new Map<string, Promise<Operation[]>>()
  private writes = new Map<string, Promise<void>>()
  private refreshing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval>
  private stopped = false
  constructor(private storage: Storage, private read: ReadTerminal) {
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined) }, 2000)
    this.timer.unref?.()
  }
  private async load(path: string): Promise<Operation[]> {
    if (this.records.has(path)) return this.records.get(path)!
    if (!this.loading.has(path)) this.loading.set(path, (async () => {
      const saved = await this.storage.get(storageKey(path))
      const records = Array.isArray(saved) ? saved.filter((op): op is Operation =>
        !!op && typeof op.id === 'string' && /^[\da-f-]{36}$/.test(op.id) && typeof op.title === 'string' &&
        ['running', 'succeeded', 'failed', 'unknown'].includes(op.status) && Array.isArray(op.lines) &&
        op.lines.every((line: unknown) => typeof line === 'string') && typeof op.startedAt === 'string' &&
        (op.terminalId === null || typeof op.terminalId === 'string')
      ).slice(0, 10) : []
      // A worker-owned short command cannot be observed after its worker has restarted.
      for (const op of records) if (op.status === 'running' && !op.terminalId) op.status = 'unknown'
      this.records.set(path, records)
      return records
    })().finally(() => this.loading.delete(path)))
    return this.loading.get(path)!
  }
  private save(path: string): Promise<void> {
    const write = (this.writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const records = this.records.get(path) ?? []
      while (records.length > 1 && Buffer.byteLength(JSON.stringify(records)) > 48_000) {
        const last = records.findLastIndex((operation) => operation.status !== 'running')
        if (last < 0) break
        records.splice(last, 1)
      }
      await this.storage.set(storageKey(path), structuredClone(records))
    })
    this.writes.set(path, write)
    return write
  }
  private async begin(path: string, title: string, service: string | null): Promise<Operation> {
    const records = await this.load(path)
    await this.refresh()
    if (records.some((op) => op.status === 'running' && (!service || !op.service || op.service === service))) {
      throw fail('action_failed', 'An operation is already running for this service or project')
    }
    if (records.filter((op) => op.status === 'running').length >= 4) throw fail('action_failed', 'Four operations are already running')
    const operation: Operation = { id: randomUUID(), title, service, terminalId: null, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, lines: [] }
    records.unshift(operation)
    // Keep active commands even when many services are used sequentially.
    if (records.length > 10) records.splice(records.findLastIndex((op) => op.status !== 'running'), 1)
    await this.save(path)
    return operation
  }
  async terminal(path: string, title: string, service: string | null, command: string, create: (command: string) => Promise<string>): Promise<string> {
    const operation = await this.begin(path, title, service)
    try {
      const tracked = trackedCommand(command, operation.id)
      if (tracked.length > 4096) throw fail('invalid_params', 'Docker command exceeds the terminal command limit')
      operation.terminalId = await create(tracked)
    } catch (error) { await this.failed(path, operation, error); throw error }
    await this.save(path)
    return operation.terminalId
  }
  async run<T extends { stdout: string; stderr: string }>(path: string, title: string, service: string | null, work: () => Promise<T>): Promise<T> {
    const operation = await this.begin(path, title, service)
    let result: T
    try {
      result = await work()
    } catch (error) { await this.failed(path, operation, error); throw error }
    operation.status = 'succeeded'; operation.exitCode = 0; operation.finishedAt = new Date().toISOString()
    operation.lines = tail([result.stdout, result.stderr].filter(Boolean))
    await this.save(path)
    return result
  }
  private async failed(path: string, operation: Operation, error: unknown): Promise<void> {
    operation.status = 'failed'; operation.finishedAt = new Date().toISOString()
    operation.exitCode = typeof (error as { exitCode?: unknown })?.exitCode === 'number' ? (error as { exitCode: number }).exitCode : null
    operation.lines = tail([error instanceof Error ? error.message : String(error)])
    await this.save(path)
  }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      for (const [path, records] of this.records) {
        let changed = false
        for (const operation of records) {
          if (!operation.terminalId || !['running', 'unknown'].includes(operation.status)) continue
          try {
            const result = await this.read(operation.terminalId)
            const marker = operationMarker(operation.id)
            const done = result.lines.map((line) => new RegExp(`^${marker} (\\d{1,3})\\s*$`).exec(line.trim())).find(Boolean)
            operation.lines = tail(result.lines.filter((line) => !line.includes(marker)))
            if (done) {
              operation.exitCode = Number(done[1]); operation.status = operation.exitCode === 0 ? 'succeeded' : 'failed'
              operation.finishedAt = new Date().toISOString()
            } else operation.status = 'running'
          } catch (error) {
            operation.status = 'unknown'
            operation.lines = tail([`Result not confirmed: ${error instanceof Error ? error.message : String(error)}`])
          }
          changed = true
        }
        if (changed) await this.save(path)
      }
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }
  async list(path: string): Promise<Operation[]> { await this.load(path); await this.refresh(); return structuredClone(this.records.get(path)!) }
  async terminalFor(path: string, id: string): Promise<string> {
    const operation = (await this.load(path)).find((operation) => operation.id === id)
    if (!operation?.terminalId) throw fail('not_permitted', 'No terminal for this workspace operation')
    return operation.terminalId
  }
  async dispose(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.refreshing?.catch(() => undefined)
    await Promise.allSettled([...this.writes.values()])
  }
}
