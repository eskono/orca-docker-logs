import { createHash } from 'node:crypto'
import { spawnDocker } from './docker'
import { timeKey } from './log-time'
import type { ContainerEvent, EventHistory } from './protocol'

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
export type EventScope = { path: string; binary: string; project: string; context: string; prefix: string[] }
export type ParsedEvent = { event: ContainerEvent; project: string; workingDir: string }
export type EventStream = (binary: string, args: string[], line: (text: string) => void, error: (message: string) => void) => () => void
const ACTIONS = new Set(['create', 'start', 'stop', 'die', 'kill', 'destroy', 'restart', 'oom', 'pause', 'unpause', 'health_status'])

export function parseDockerEvent(text: string): ParsedEvent | null {
  try {
    const raw = JSON.parse(text)
    const actionText = String(raw.Action ?? raw.status ?? '')
    const action = actionText.split(':')[0]
    const attributes = raw.Actor?.Attributes ?? {}
    const id = raw.Actor?.ID ?? raw.id
    const service = attributes['com.docker.compose.service']
    const project = attributes['com.docker.compose.project']
    const workingDir = attributes['com.docker.compose.project.working_dir']
    if (raw.Type !== 'container' || !ACTIONS.has(action) || typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id) ||
      typeof service !== 'string' || typeof project !== 'string' || typeof workingDir !== 'string') return null
    // JSON numbers lose nanoseconds; read the integer token before converting it to a date.
    const nanos = /"timeNano"\s*:\s*"?(\d+)/.exec(text)?.[1] ?? `${Math.floor(Number(raw.time))}000000000`
    const value = BigInt(nanos)
    const seconds = value / 1_000_000_000n
    const t = new Date(Number(seconds) * 1000).toISOString().slice(0, 19) + `.${String(value % 1_000_000_000n).padStart(9, '0')}Z`
    const detail = action === 'health_status' ? actionText.slice(actionText.indexOf(':') + 1).trim() :
      attributes.exitCode !== undefined ? `exit ${attributes.exitCode}` : attributes.signal !== undefined ? `signal ${attributes.signal}` : ''
    return { project, workingDir, event: {
      id: createHash('sha256').update(`${id}\0${nanos}\0${actionText}`).digest('hex').slice(0, 32),
      t, containerId: id, service: service.slice(0, 255), name: String(attributes.name ?? id.slice(0, 12)).slice(0, 255), action, detail: detail.slice(0, 120)
    } }
  } catch { return null }
}

export const followEvents: EventStream = (binary, args, onLine, onError) => {
  const child = spawnDocker(binary, args)
  let pending = '', stderr = '', stopped = false, ended = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.length <= 65_536) onLine(line)
    }
    if (pending.length > 65_536) { pending = ''; onError('An oversized Docker event was omitted') }
  })
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1024) })
  const fail = (message: string) => { if (!stopped && !ended) { ended = true; onError(message) } }
  child.on('error', (error) => fail(error.message))
  child.on('close', (code) => fail(stderr.trim() || `Docker event stream ended${code !== null ? ` (${code})` : ''}`))
  return () => { stopped = true; child.kill('SIGTERM') }
}

type State = EventHistory & {
  key: string; scope: EventScope; lease: number; stop?: () => void; retry?: ReturnType<typeof setTimeout>
  saveTimer?: ReturnType<typeof setTimeout>; queue: Promise<void>; write: Promise<void>; pending: number; backoff: number
}

/** Record observed events across container recreation; retain a bounded history per Docker target. */
export class Events {
  private states = new Map<string, State>()
  private loading = new Map<string, Promise<State>>()
  private stopped = false
  private timer: ReturnType<typeof setInterval>
  constructor(private storage: Storage, private stream: EventStream = followEvents,
    private accepts: (path: string, event: ParsedEvent) => Promise<boolean> = async () => true) {
    this.timer = setInterval(() => {
      for (const state of this.states.values()) if (state.lease < Date.now()) this.stop(state)
    }, 5000)
    this.timer.unref?.()
  }
  private stop(state: State): void {
    state.stop?.(); state.stop = undefined; state.connected = false
    if (state.retry) clearTimeout(state.retry)
    state.retry = undefined
  }
  private save(state: State): Promise<void> {
    state.write = state.write.catch(() => undefined).then(async () => {
      await this.storage.set(state.key, { events: structuredClone(state.events), startedAt: state.startedAt, limited: state.limited })
    })
    return state.write
  }
  private saveSoon(state: State): void {
    if (state.saveTimer) return
    state.saveTimer = setTimeout(() => {
      state.saveTimer = undefined
      void this.save(state).catch((error) => { state.error = `Could not save event history: ${String(error)}`.slice(0, 512) })
    }, 500)
    state.saveTimer.unref?.()
  }
  private start(state: State): void {
    if (this.stopped || state.stop || state.retry || state.lease < Date.now()) return
    const active = [...this.states.values()].filter((other) => other.stop)
    if (active.length >= 2) this.stop(active.sort((a, b) => a.lease - b.lease)[0])
    const since = state.events.at(-1)?.t ?? new Date(Date.now() - 5 * 60_000).toISOString()
    state.connected = true
    state.stop = this.stream(state.scope.binary, [...state.scope.prefix, 'events', '--filter', 'type=container', '--filter', `label=com.docker.compose.project=${state.scope.project}`, '--format', '{{json .}}', '--since', since], (text) => {
      if (this.stopped) return
      const parsed = parseDockerEvent(text)
      if (!parsed || parsed.project !== state.scope.project) return
      if (state.pending >= 256) { state.limited = true; return }
      state.pending++
      state.queue = state.queue.then(async () => {
        if (!await this.accepts(state.scope.path, parsed) || state.events.some((event) => event.id === parsed.event.id)) return
        state.error = null; state.connected = true; state.backoff = 1000
        state.events.push(parsed.event)
        state.events.sort((a, b) => timeKey(a.t).localeCompare(timeKey(b.t)))
        while (state.events.length > 200 || Buffer.byteLength(JSON.stringify(state.events)) > 48_000) { state.events.shift(); state.limited = true }
        this.saveSoon(state)
      }).catch((error) => { state.error = String(error).slice(0, 512) }).finally(() => { state.pending-- })
    }, (message) => {
      this.stop(state)
      state.error = message.slice(0, 512)
      if (!this.stopped && state.lease >= Date.now()) {
        state.retry = setTimeout(() => { state.retry = undefined; this.start(state) }, state.backoff)
        state.retry.unref?.()
        state.backoff = Math.min(state.backoff * 2, 30_000)
      }
    })
  }
  async watch(scope: EventScope): Promise<EventHistory> {
    const key = `events:${createHash('sha256').update(`${scope.path}\0${scope.context}\0${scope.project}`).digest('hex')}`
    if (!this.states.has(key)) {
      if (!this.loading.has(key)) this.loading.set(key, (async () => {
        const saved = await this.storage.get(key) as { events?: ContainerEvent[]; startedAt?: string; limited?: boolean } | null
        const events = Array.isArray(saved?.events) ? saved.events.filter((event) => !!event && typeof event.id === 'string' && typeof event.t === 'string' && typeof event.service === 'string' && typeof event.containerId === 'string' && ACTIONS.has(event.action)).slice(-200) : []
        const state: State = { key, scope, events, connected: false, error: null, startedAt: typeof saved?.startedAt === 'string' ? saved.startedAt : new Date().toISOString(), limited: saved?.limited === true, lease: Date.now() + 30_000, queue: Promise.resolve(), write: Promise.resolve(), pending: 0, backoff: 1000 }
        this.states.set(key, state)
        return state
      })().finally(() => this.loading.delete(key)))
      await this.loading.get(key)
    }
    const state = this.states.get(key)!
    state.lease = Date.now() + 30_000
    for (const other of this.states.values()) if (other.scope.path === scope.path && other.key !== key) this.stop(other)
    this.start(state)
    await state.queue
    return { events: structuredClone(state.events).reverse(), connected: state.connected, error: state.error, startedAt: state.startedAt, limited: state.limited }
  }
  async dispose(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await Promise.allSettled([...this.loading.values()])
    for (const state of this.states.values()) { this.stop(state); if (state.saveTimer) clearTimeout(state.saveTimer) }
    await Promise.allSettled([...this.states.values()].map(async (state) => { await state.queue; await this.save(state) }))
  }
}
