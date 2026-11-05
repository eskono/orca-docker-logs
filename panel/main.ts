// The panel: compose services of the chosen project, their state and actions, and one container's log.
import type { FocusContext, LogLine, Requests, ServiceAction, ServiceRow, Workspace } from '../src/protocol'
import { parseAnsi, stripAnsi, type Style } from './ansi'

type Orca = {
  on(event: 'workspace.changed', handler: (payload: { context: FocusContext }) => void): unknown
  plugin: {
    request<K extends keyof Requests>(
      name: K,
      input: Requests[K]['input'],
      options?: { timeoutMs?: number }
    ): Promise<Requests[K]['output']>
  }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
}
declare const orca: Orca

const LOG_POLL_MS = 2000
const SERVICES_POLL_MS = 5000

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const els = {
  workspace: $<HTMLSelectElement>('workspace'),
  refresh: $<HTMLButtonElement>('refresh'),
  notice: $<HTMLDivElement>('notice'),
  services: $<HTMLUListElement>('services'),
  logTitle: $<HTMLElement>('log-title'),
  clear: $<HTMLButtonElement>('clear'),
  filter: $<HTMLInputElement>('filter'),
  follow: $<HTMLInputElement>('follow'),
  timestamps: $<HTMLInputElement>('timestamps'),
  wrap: $<HTMLInputElement>('wrap'),
  cleared: $<HTMLDivElement>('cleared'),
  clearedText: $<HTMLSpanElement>('cleared-text'),
  showAll: $<HTMLButtonElement>('show-all'),
  log: $<HTMLDivElement>('log')
}

const state = {
  context: null as FocusContext,
  /** Null until the worker first answers which workspaces have compose files. */
  workspaces: null as Workspace[] | null,
  focused: null as Workspace | null,
  path: null as string | null,
  rows: [] as ServiceRow[],
  /** Whether `rows` answers for `path` yet (false while the first list loads). */
  servicesLoaded: false,
  /** The selected row (container id or `service:<name>`) and its service. */
  key: null as string | null,
  service: null as string | null,
  lines: [] as LogLine[],
  clearedAt: null as string | null,
  truncated: false,
  notice: null as { text: string; error: boolean } | null,
  logError: null as string | null,
  busy: new Set<string>()
}
/** The service last viewed in each project, picked again when the project comes back. */
const lastService = new Map<string, string>()
/** Bumped whenever the project or row changes, so answers for the old one are dropped. */
let generation = 0
let servicesInFlight = false
let logsInFlight = false

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const selectedRow = () => state.rows.find((r) => r.key === state.key) ?? null
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ---------- rendering ----------

function renderNotice(): void {
  const notice = state.notice
  els.notice.hidden = !notice
  els.notice.textContent = notice?.text ?? ''
  els.notice.classList.toggle('error', notice?.error ?? false)
}

function workspaceLabel(w: Workspace): string {
  return w.branch ? `${basename(w.path)} · ${w.branch}` : basename(w.path)
}

function renderWorkspaces(): void {
  const workspaces = state.workspaces ?? []
  const options: HTMLOptionElement[] = []
  if (!state.path || !workspaces.some((w) => w.path === state.path)) {
    const text = !state.workspaces ? 'Loading…' : workspaces.length ? 'Choose a project…' : 'No projects with a compose file'
    const placeholder = el('option', undefined, text)
    placeholder.value = ''
    options.push(placeholder)
  }
  for (const w of workspaces) {
    const option = el('option', undefined, workspaceLabel(w) + (w.path === state.focused?.path ? '  (focused)' : ''))
    option.value = w.path
    option.title = w.path
    options.push(option)
  }
  els.workspace.replaceChildren(...options)
  els.workspace.value = state.path ?? ''
  els.workspace.disabled = workspaces.length === 0
}

function tone(row: ServiceRow): string {
  if (row.state === 'running') return row.health === 'unhealthy' ? 'bad' : row.health === 'starting' ? 'warn' : 'ok'
  if (row.state === 'restarting' || row.state === 'paused') return 'warn'
  if (row.state === 'dead') return 'bad'
  if (row.state === 'exited') return /\((?!0\))\d+\)/.test(row.status) ? 'bad' : 'off'
  if (row.state === 'not created') return 'none'
  return 'off'
}

const ACTION_LABELS: Record<ServiceAction, [icon: string, label: string]> = {
  start: ['▶', 'Start'],
  stop: ['■', 'Stop'],
  restart: ['↻', 'Restart']
}

function rowActions(row: ServiceRow): ServiceAction[] {
  return ['running', 'restarting', 'paused'].includes(row.state) ? ['restart', 'stop'] : ['start']
}

function renderServices(): void {
  const replicas = new Map<string, number>()
  for (const row of state.rows) replicas.set(row.service, (replicas.get(row.service) ?? 0) + 1)
  const items = state.rows.map((row) => {
    const selected = row.key === state.key
    const item = el('li', selected ? 'service selected' : 'service')
    const pick = el('button', 'pick')
    pick.setAttribute('aria-pressed', String(selected))
    pick.title = `${row.name}\n${row.status}`
    pick.append(
      el('span', `dot ${tone(row)}`),
      el('span', 'name', (replicas.get(row.service) ?? 0) > 1 ? row.name : row.service),
      el('span', 'status', state.busy.has(row.key) ? 'Working…' : row.status)
    )
    pick.addEventListener('click', () => selectRow(row))
    const actions = el('span', 'actions')
    for (const action of rowActions(row)) {
      const [icon, label] = ACTION_LABELS[action]
      const button = el('button', undefined, icon)
      button.title = `${label} ${row.service}`
      button.setAttribute('aria-label', `${label} ${row.name}`)
      button.disabled = state.busy.has(row.key)
      button.addEventListener('click', () => void act(row, action))
      actions.append(button)
    }
    item.append(pick, actions)
    return item
  })
  els.services.replaceChildren(...items)
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(date.getTime())) return timestamp
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function styled(text: string, style: Style): Node {
  const classes: string[] = []
  let css = ''
  if (typeof style.fg === 'number') classes.push(`f${style.fg}`)
  else if (style.fg) css += `color:${style.fg};`
  if (typeof style.bg === 'number') classes.push(`k${style.bg}`)
  else if (style.bg) css += `background:${style.bg};`
  if (style.bold) classes.push('b')
  if (style.dim) classes.push('d')
  if (style.italic) classes.push('i')
  if (style.underline) classes.push('u')
  if (!classes.length && !css) return document.createTextNode(text)
  const span = el('span', classes.join(' '), text)
  if (css) span.style.cssText = css
  return span
}

function renderLine(line: LogLine, withTime: boolean): HTMLElement {
  const node = el('div', line.e ? 'line err' : 'line')
  if (withTime && line.t) node.append(el('span', 'ts', `${formatTime(line.t)} `))
  for (const segment of parseAnsi(line.m)) node.append(styled(segment.text, segment.style))
  if (!node.childNodes.length) node.append('​') // keep empty lines one line tall
  return node
}

function logPlaceholder(): string | null {
  const row = selectedRow()
  if (state.logError) return state.logError
  if (!state.path) return 'Choose a project to see its containers.'
  if (!row) return !state.servicesLoaded ? 'Loading…' : state.rows.length ? 'Choose a container.' : 'No containers.'
  if (!row.containerId) return 'This service has no container yet. Start it to create one.'
  return null
}

function renderLog(scrollToEnd = false): void {
  const pane = els.log
  const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32
  const row = selectedRow()
  els.logTitle.textContent = row ? `Logs · ${row.name}` : 'Logs'
  els.clear.disabled = !row?.containerId
  els.cleared.hidden = !state.clearedAt
  els.clearedText.textContent = state.clearedAt ? `Showing lines after ${formatTime(state.clearedAt)}.` : ''
  pane.classList.toggle('wrap', els.wrap.checked)

  const fragment = document.createDocumentFragment()
  const placeholder = logPlaceholder()
  if (placeholder) {
    fragment.append(el('div', 'placeholder', placeholder))
  } else {
    const filter = els.filter.value.trim().toLowerCase()
    const withTime = els.timestamps.checked
    if (state.truncated && !filter) fragment.append(el('div', 'placeholder', 'Older lines are not shown.'))
    let shown = 0
    for (const line of state.lines) {
      if (filter && !stripAnsi(line.m).toLowerCase().includes(filter)) continue
      fragment.append(renderLine(line, withTime))
      shown++
    }
    if (!shown) fragment.append(el('div', 'placeholder', filter ? 'No lines match the filter.' : 'No log lines yet.'))
  }
  pane.replaceChildren(fragment)
  if (scrollToEnd || (els.follow.checked && atEnd)) pane.scrollTop = pane.scrollHeight
}

// ---------- data ----------

function setNotice(text: string | null, error = false): void {
  state.notice = text ? { text, error } : null
  renderNotice()
}

async function refreshWorkspaces(): Promise<void> {
  try {
    const { workspaces, focused } = await orca.plugin.request('workspaces.list', { context: state.context })
    // `workspace.changed` also fires when terminals open or close: follow focus only when it
    // moved, so a project picked by hand stays until then.
    const focusMoved = focused?.path !== state.focused?.path
    state.workspaces = workspaces
    state.focused = focused
    const listed = (path: string | null) => !!path && workspaces.some((w) => w.path === path)
    let next = listed(state.path) ? state.path : null
    if ((focusMoved || !next) && focused && listed(focused.path)) next = focused.path
    renderWorkspaces()
    if (next !== state.path) setPath(next)
    else setNotice(projectHint())
  } catch (error) {
    setNotice(errorText(error), true)
  }
}

function projectHint(): string | null {
  if (!state.workspaces) return null
  if (!state.workspaces.length) return 'No local Orca workspace has a compose file (compose.yaml, docker-compose.yml, …).'
  if (state.path) return null
  const focused = state.focused
  const noCompose = focused && !state.workspaces.some((w) => w.path === focused.path)
  return noCompose ? `No compose file in ${basename(focused.path)}. Choose a project above.` : 'Choose a project above.'
}

function setPath(path: string | null): void {
  state.path = path
  setNotice(projectHint())
  state.rows = []
  state.servicesLoaded = false
  state.key = null
  state.service = path ? lastService.get(path) ?? null : null
  state.lines = []
  state.clearedAt = null
  state.logError = null
  generation++
  renderWorkspaces()
  renderServices()
  renderLog(true)
  void loadServices()
}

function pickRow(rows: ServiceRow[]): ServiceRow | null {
  return (
    rows.find((r) => r.key === state.key) ??
    rows.find((r) => r.service === state.service && r.containerId) ??
    rows.find((r) => r.service === state.service) ??
    rows.find((r) => r.state === 'running') ??
    rows[0] ??
    null
  )
}

async function loadServices(): Promise<void> {
  const path = state.path
  if (!path || servicesInFlight) return
  servicesInFlight = true
  const at = generation
  try {
    const { rows } = await orca.plugin.request('services.list', { path })
    if (at !== generation) return
    state.rows = rows
    state.servicesLoaded = true
    if (state.notice?.error) setNotice(null)
    const row = pickRow(rows)
    if (row && row.key !== state.key) selectRow(row)
    else renderServices()
    if (!row) renderLog()
  } catch (error) {
    if (at !== generation) return
    state.rows = []
    state.servicesLoaded = true
    renderServices()
    setNotice(errorText(error), true)
    renderLog()
  } finally {
    servicesInFlight = false
  }
}

function selectRow(row: ServiceRow): void {
  const sameContainer = row.key === state.key
  state.key = row.key
  state.service = row.service
  if (state.path) lastService.set(state.path, row.service)
  renderServices()
  if (sameContainer) return
  state.lines = []
  state.clearedAt = null
  state.truncated = false
  state.logError = null
  generation++
  renderLog(true)
  void loadLogs(true)
}

function sameLines(a: LogLine[], b: LogLine[]): boolean {
  if (a.length !== b.length) return false
  if (!a.length) return true
  const [a0, b0, a1, b1] = [a[0], b[0], a[a.length - 1], b[b.length - 1]]
  return a0.t === b0.t && a0.m === b0.m && a1.t === b1.t && a1.m === b1.m
}

async function loadLogs(force = false): Promise<void> {
  const row = selectedRow()
  const path = state.path
  if (!path || !row?.containerId || (logsInFlight && !force)) return
  logsInFlight = true
  const at = generation
  try {
    const answer = await orca.plugin.request('logs.get', { path, service: row.service, containerId: row.containerId })
    if (at !== generation) return
    const changed = !sameLines(answer.lines, state.lines) || answer.clearedAt !== state.clearedAt || state.logError !== null
    state.lines = answer.lines
    state.clearedAt = answer.clearedAt
    state.truncated = answer.truncated
    state.logError = null
    if (changed || force) renderLog(force)
  } catch (error) {
    if (at !== generation) return
    state.logError = errorText(error)
    renderLog()
  } finally {
    logsInFlight = false
  }
}

async function act(row: ServiceRow, action: ServiceAction): Promise<void> {
  const path = state.path
  if (!path) return
  state.busy.add(row.key)
  renderServices()
  try {
    // `compose up` may build or pull images first.
    await orca.plugin.request('service.action', { path, service: row.service, containerId: row.containerId, action }, { timeoutMs: 120_000 })
    setNotice(null)
  } catch (error) {
    setNotice(`${ACTION_LABELS[action][1]} ${row.service} failed: ${errorText(error)}`, true)
  } finally {
    state.busy.delete(row.key)
    renderServices()
  }
  if (path !== state.path) return
  await loadServices()
  await loadLogs(true)
}

async function clearLogs(reset: boolean): Promise<void> {
  const row = selectedRow()
  if (!state.path || !row) return
  try {
    const { clearedAt } = await orca.plugin.request('logs.clear', { path: state.path, service: row.service, reset })
    state.clearedAt = clearedAt
    if (!reset) state.lines = []
    state.truncated = false
    renderLog(true)
    await loadLogs(true)
  } catch (error) {
    setNotice(errorText(error), true)
  }
}

// ---------- preferences ----------

const PREFS_KEY = 'prefs'
const toggles = { follow: els.follow, timestamps: els.timestamps, wrap: els.wrap }

async function loadPrefs(): Promise<void> {
  try {
    const prefs = (await orca.storage.get(PREFS_KEY)) as Partial<Record<keyof typeof toggles, boolean>> | null
    for (const [name, input] of Object.entries(toggles)) {
      const value = prefs?.[name as keyof typeof toggles]
      if (typeof value === 'boolean') input.checked = value
    }
  } catch {
    // Defaults from the markup stay.
  }
}

function savePrefs(): void {
  const prefs = Object.fromEntries(Object.entries(toggles).map(([name, input]) => [name, input.checked]))
  void orca.storage.set(PREFS_KEY, prefs).catch(() => undefined)
}

// ---------- wiring ----------

els.workspace.addEventListener('change', () => setPath(els.workspace.value || null))
els.refresh.addEventListener('click', () => {
  void refreshWorkspaces().then(() => loadServices()).then(() => loadLogs(true))
})
els.clear.addEventListener('click', () => void clearLogs(false))
els.showAll.addEventListener('click', () => void clearLogs(true))
els.filter.addEventListener('input', () => renderLog())
for (const input of Object.values(toggles)) {
  input.addEventListener('change', () => {
    savePrefs()
    renderLog(input === els.follow && input.checked)
    if (input === els.follow && input.checked) void loadLogs()
  })
}

setInterval(() => {
  if (!document.hidden && els.follow.checked) void loadLogs()
}, LOG_POLL_MS)
setInterval(() => {
  if (!document.hidden) void loadServices()
}, SERVICES_POLL_MS)

renderWorkspaces()
renderLog()
void loadPrefs().then(() => {
  renderLog()
  // Fires once with the current context as it subscribes, then on every focus change.
  orca.on('workspace.changed', ({ context }) => {
    state.context = context
    void refreshWorkspaces()
  })
})
