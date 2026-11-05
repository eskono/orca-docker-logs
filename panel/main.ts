// The panel: compose services of the chosen project, their state, resources and actions, and the log
// of one container or of all of them.
import type {
  ContainerStats,
  FocusContext,
  LogLine,
  LogTarget,
  ProjectAction,
  Requests,
  ServiceAction,
  ServiceRow,
  Workspace
} from '../src/protocol'
import { problemOf } from '../src/status'
import { parseAnsi, stripAnsi, type Style } from './ansi'
import { icon, type IconName } from './icons'
import { levels, levelToken, type Level } from './levels'
import { findLinks, type LogLink } from './links'
import { parseBytes, parsePercent, sparkPoints } from './sparkline'

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
  shell: { openExternal(url: string): Promise<{ opened: boolean }> }
  files: { saveAs(options: { suggestedName?: string; mimeType?: string; data: string }): Promise<{ status: string }> }
}
declare const orca: Orca

const LOG_POLL_MS = 2000
const SERVICES_POLL_MS = 5000
const INFO_NOTICE_MS = 8000
const DOWN_CONFIRM_MS = 4000
/** The pseudo-row that shows every container's log at once. */
const ALL = 'all'
const WINDOWS: Record<string, number> = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 }
const SOURCE_COLORS = [2, 4, 5, 6, 3, 10, 12, 13, 14, 11]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const els = {
  workspace: $<HTMLSelectElement>('workspace'),
  refresh: $<HTMLButtonElement>('refresh'),
  up: $<HTMLButtonElement>('project-up'),
  restart: $<HTMLButtonElement>('project-restart'),
  down: $<HTMLButtonElement>('project-down'),
  notice: $<HTMLDivElement>('notice'),
  services: $<HTMLUListElement>('services'),
  logTitle: $<HTMLElement>('log-title'),
  ask: $<HTMLButtonElement>('ask'),
  save: $<HTMLButtonElement>('save'),
  clear: $<HTMLButtonElement>('clear'),
  filter: $<HTMLInputElement>('filter'),
  level: $<HTMLSelectElement>('level'),
  window: $<HTMLSelectElement>('window'),
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
  project: '',
  rows: [] as ServiceRow[],
  /** Whether `rows` answers for `path` yet (false while the first list loads). */
  servicesLoaded: false,
  /** The selected row (container id, `service:<name>` or `all`) and its service. */
  key: null as string | null,
  service: null as string | null,
  lines: [] as LogLine[],
  clearedAt: null as string | null,
  truncated: false,
  notice: null as { text: string; error: boolean } | null,
  logError: null as string | null,
  busy: new Set<string>(),
  projectBusy: null as ProjectAction | null,
  confirmDown: false,
  /** CPU and memory of running containers by container id, from the last `stats.get`. */
  stats: {} as Record<string, ContainerStats>
}
/** The row last viewed in each project, picked again when the project comes back. */
const lastSelection = new Map<string, { key: string; service: string | null }>()
/** Bumped whenever the project or the shown log changes, so answers for the old one are dropped. */
let generation = 0
let servicesInFlight = false
let logsInFlight = false
let statsInFlight = false

/** Resource samples per container, newest last, from each `stats.get` while the panel is open. */
const HISTORY_SAMPLES = 60
const SPARK_WIDTH = 46
const SPARK_HEIGHT = 14
type Sample = { cpu: number; mem: number }
const history = new Map<string, Sample[]>()

/** `service\0container path` → project file (relative), null when it is not one; absent while unknown. */
const sources = new Map<string, string | null>()
/** Stack trace paths seen on screen and not asked about yet, by service. */
const unresolved = new Map<string, Set<string>>()
let resolving = false
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let downTimer: ReturnType<typeof setTimeout> | undefined

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const selectedRow = () => state.rows.find((r) => r.key === state.key) ?? null
const showingAll = () => state.key === ALL
const containers = () => state.rows.filter((r) => r.containerId)
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(name: IconName, label: string, onPress: () => void, disabled = false): HTMLButtonElement {
  const button = el('button')
  button.append(icon(name))
  button.title = label
  button.setAttribute('aria-label', label)
  button.disabled = disabled
  button.addEventListener('click', onPress)
  return button
}

// ---------- formatting ----------

/** `45s`, `12m`, `5h`, `3d`. */
function age(since: string | null): string {
  if (!since) return ''
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function statusText(row: ServiceRow): string {
  if (state.busy.has(row.key)) return 'Working…'
  switch (row.state) {
    case 'running':
      return `Up ${age(row.startedAt)}${row.health ? ` · ${row.health}` : ''}`
    case 'exited':
      return `Exited (${row.exitCode ?? '?'}) ${age(row.finishedAt)} ago`
    case 'not created':
      return row.profiles.length ? `Not created · profile ${row.profiles.join(', ')}` : 'Not created'
    default:
      return row.state.charAt(0).toUpperCase() + row.state.slice(1)
  }
}

function tone(row: ServiceRow): string {
  if (problemOf(row)) return 'bad'
  if (row.state === 'running') return row.health === 'starting' ? 'warn' : 'ok'
  if (row.state === 'paused') return 'warn'
  return row.state === 'not created' ? 'none' : 'off'
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp.replace(/(\.\d{3})\d+/, '$1'))
  if (Number.isNaN(date.getTime())) return timestamp
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function sourceColor(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return SOURCE_COLORS[Math.abs(hash) % SOURCE_COLORS.length]
}

// ---------- rendering ----------

function renderNotice(): void {
  const notice = state.notice
  els.notice.hidden = !notice
  els.notice.textContent = notice?.text ?? ''
  els.notice.classList.toggle('error', notice?.error ?? false)
}

function setNotice(text: string | null, error = false): void {
  clearTimeout(noticeTimer)
  state.notice = text ? { text, error } : null
  renderNotice()
  // Errors stay until something replaces them; confirmations fade.
  if (text && !error) noticeTimer = setTimeout(() => setNotice(projectHint()), INFO_NOTICE_MS)
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

function renderProjectActions(): void {
  const idle = !!state.path && state.servicesLoaded && !state.projectBusy
  els.up.disabled = !idle
  els.restart.disabled = !idle || containers().length === 0
  els.down.disabled = !idle || containers().length === 0
  els.up.textContent = state.projectBusy === 'up' ? 'Starting…' : 'Up'
  els.restart.textContent = state.projectBusy === 'restart' ? 'Restarting…' : 'Restart'
  els.down.textContent = state.projectBusy === 'down' ? 'Stopping…' : state.confirmDown ? 'Confirm down' : 'Down'
  els.down.classList.toggle('danger', state.confirmDown)
  els.up.prepend(icon('up'))
  els.restart.prepend(icon('restart'))
  els.down.prepend(icon('down'))
}

function rowActions(row: ServiceRow): [IconName, string, () => void][] {
  const label = row.name
  const build: [IconName, string, () => void][] = row.build ? [['build', `Rebuild ${row.service} (in a terminal)`, () => void act(row, 'build')]] : []
  if (['running', 'restarting', 'paused'].includes(row.state)) {
    return [
      ...(row.state === 'running' ? [['shell', `Open a shell in ${label}`, () => void openShell(row)] as [IconName, string, () => void]] : []),
      ...build,
      ['restart', `Restart ${label}`, () => void act(row, 'restart')],
      ['stop', `Stop ${label}`, () => void act(row, 'stop')]
    ]
  }
  const start = row.containerId ? `Start ${label}` : `Create and start ${row.service} (in a terminal)`
  return [...build, ['play', start, () => void act(row, 'start')]]
}

function renderAllRow(): HTMLLIElement | null {
  const created = containers()
  if (created.length < 2) return null
  const selected = showingAll()
  const item = el('li', selected ? 'service selected' : 'service')
  const pick = el('button', 'pick')
  pick.setAttribute('aria-pressed', String(selected))
  const glyph = icon('all')
  glyph.setAttribute('class', 'all-icon')
  const text = el('span', 'text')
  const running = created.filter((r) => r.state === 'running').length
  text.append(el('span', 'name', 'All services'), el('span', 'status', `${running} of ${created.length} running`))
  pick.append(glyph, text)
  pick.addEventListener('click', () => selectKey(ALL, null))
  item.append(pick)
  return item
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)}GiB` : `${(bytes / 1024 ** 2).toFixed(1)}MiB`
}

function historyText(samples: Sample[]): string {
  const cpu = samples.map((s) => s.cpu)
  const mem = samples.map((s) => s.mem)
  const minutes = Math.max(1, Math.round((samples.length * SERVICES_POLL_MS) / 60_000))
  return [
    `Last ~${minutes} min (line: CPU, dashes: memory)`,
    `CPU ${Math.min(...cpu).toFixed(1)}–${Math.max(...cpu).toFixed(1)}%`,
    `Memory ${formatBytes(Math.min(...mem))}–${formatBytes(Math.max(...mem))}`
  ].join('\n')
}

/** CPU (line) and memory (dashes) over the last samples; idle CPU stays near the bottom. */
function sparkline(samples: Sample[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`)
  svg.setAttribute('class', 'spark')
  svg.setAttribute('aria-hidden', 'true')
  const cpu = samples.map((s) => s.cpu)
  const mem = samples.map((s) => s.mem)
  const series: [number[], number, string][] = [
    [mem, Math.max(...mem) * 1.15 || 1, 'spark-mem'],
    [cpu, Math.max(10, ...cpu), 'spark-cpu']
  ]
  // A short history spreads over the width; past 12 samples it compresses, up to HISTORY_SAMPLES.
  const slots = Math.max(12, samples.length)
  for (const [values, max, className] of series) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    line.setAttribute('points', sparkPoints(values, slots, SPARK_WIDTH, SPARK_HEIGHT, max))
    line.setAttribute('class', className)
    svg.append(line)
  }
  return svg
}

function renderServices(): void {
  const replicas = new Map<string, number>()
  for (const row of state.rows) replicas.set(row.service, (replicas.get(row.service) ?? 0) + 1)
  const items = state.rows.map((row) => {
    const selected = row.key === state.key
    const item = el('li', selected ? 'service selected' : 'service')
    const pick = el('button', 'pick')
    pick.setAttribute('aria-pressed', String(selected))
    const usage = row.containerId && row.state === 'running' ? state.stats[row.containerId] : undefined
    const status = statusText(row)
    const tooltip = [row.name, status]
    if (row.healthLog) tooltip.push(`Last health check: ${row.healthLog}`)
    if (usage) tooltip.push(`CPU ${usage.cpu}`, `Memory ${usage.mem} / ${usage.memLimit} (${usage.memPercent})`)
    const samples = row.containerId && row.state === 'running' ? history.get(row.containerId) ?? [] : []
    if (samples.length >= 2) tooltip.push(historyText(samples))
    pick.title = tooltip.join('\n')
    const text = el('span', 'text')
    text.append(
      el('span', 'name', (replicas.get(row.service) ?? 0) > 1 ? row.name : row.service),
      el('span', tone(row) === 'bad' ? 'status bad' : 'status', status)
    )
    pick.append(el('span', `dot ${tone(row)}`), text)
    pick.addEventListener('click', () => selectKey(row.key, row.service))
    item.append(pick)

    const side = el('span', 'side')
    if (usage) {
      const usageRow = el('span', 'usage-row')
      if (samples.length >= 2) usageRow.append(sparkline(samples))
      usageRow.append(el('span', 'usage', `${usage.cpu} ${usage.mem}`))
      side.append(usageRow)
    }
    if (row.state === 'running' && row.ports.length) {
      const ports = el('span', 'ports')
      for (const port of row.ports.slice(0, 4)) {
        const link = el('button', 'port', `:${port}`)
        link.title = `Open http://localhost:${port}`
        link.addEventListener('click', () => void openUrl(`http://localhost:${port}`))
        ports.append(link)
      }
      side.append(ports)
    }
    if (side.childNodes.length) item.append(side)

    const actions = el('span', 'actions')
    for (const [name, label, onPress] of rowActions(row)) actions.append(iconButton(name, label, onPress, state.busy.has(row.key)))
    item.append(actions)
    return item
  })
  const all = renderAllRow()
  els.services.replaceChildren(...(all ? [all] : []), ...items)
  renderProjectActions()
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

type Shown = { line: LogLine; text: string; level: Level }

let levelCache: { lines: LogLine[]; shown: Shown[] } | null = null

/** Every line with its plain text and level, computed once per answer from the worker. */
function analyzed(): Shown[] {
  if (levelCache?.lines !== state.lines) {
    const texts = state.lines.map((l) => stripAnsi(l.m))
    const lineLevels = levels(texts)
    levelCache = { lines: state.lines, shown: state.lines.map((line, i) => ({ line, text: texts[i], level: lineLevels[i] })) }
  }
  return levelCache.shown
}

/** The lines the level and filter let through. */
function visibleLines(): Shown[] {
  const filter = els.filter.value.trim().toLowerCase()
  const level = els.level.value
  return analyzed().filter(
    ({ line, text, level: l }) =>
      (level === 'all' || l === 'error' || (level === 'warn' && l === 'warn')) &&
      (!filter || text.toLowerCase().includes(filter) || (line.src ?? '').toLowerCase().includes(filter))
  )
}

function linkLabel(link: LogLink, source: string | null | undefined): string {
  return link.kind === 'url' ? `Open ${link.url}` : `Open ${source}:${link.line} in the editor`
}

/**
 * `text` with its web addresses and stack trace locations as links. A location becomes a link once
 * the worker confirmed it is a file of the project; until then it is queued and stays text.
 */
function linkified(text: string, wrap: (piece: string) => Node, service: string | null): Node[] {
  const nodes: Node[] = []
  let last = 0
  for (const link of findLinks(text)) {
    let source: string | null | undefined
    if (link.kind === 'file') {
      if (!service) continue
      source = sources.get(`${service}\0${link.file}`)
      if (source === undefined) unresolved.set(service, (unresolved.get(service) ?? new Set()).add(link.file))
      if (!source) continue
    }
    if (link.start > last) nodes.push(wrap(text.slice(last, link.start)))
    const anchor = el('span', 'log-link')
    anchor.append(wrap(text.slice(link.start, link.end)))
    anchor.setAttribute('role', 'link')
    anchor.tabIndex = 0
    anchor.title = linkLabel(link, source)
    const activate = () => void (link.kind === 'url' ? openUrl(link.url) : openSource(service as string, link))
    anchor.addEventListener('click', activate)
    anchor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') activate()
    })
    nodes.push(anchor)
    last = link.end
  }
  if (last < text.length) nodes.push(wrap(text.slice(last)))
  return nodes
}

function renderLine({ line, level }: Shown, withTime: boolean, sourceWidth: number, service: string | null): HTMLElement {
  const node = el('div', ['line', line.e ? 'err' : '', level ? `lvl-${level}` : ''].filter(Boolean).join(' '))
  if (withTime && line.t) node.append(el('span', 'ts', `${formatTime(line.t)} `))
  if (line.src) node.append(el('span', `src f${sourceColor(line.src)}`, `${line.src.padEnd(sourceWidth)} │ `))
  const segments = parseAnsi(line.m)
  const plain = (piece: string) => document.createTextNode(piece)
  if (segments.every((s) => Object.keys(s.style).length === 0)) {
    // Most programs drop their colours when Docker, not a terminal, reads their output: colour the
    // level word ourselves so INFO, WARNING and ERROR still stand out.
    const text = segments.map((s) => s.text).join('')
    const token = levelToken(text)
    if (token) {
      node.append(
        ...linkified(text.slice(0, token.start), plain, service),
        el('span', `level-word ${token.tone}`, text.slice(token.start, token.end)),
        ...linkified(text.slice(token.end), plain, service)
      )
    } else if (text) {
      node.append(...linkified(text, plain, service))
    }
  } else {
    for (const segment of segments) node.append(...linkified(segment.text, (piece) => styled(piece, segment.style), service))
  }
  if (node.childNodes.length === 0) node.append('​') // keep empty lines one line tall
  return node
}

function logPlaceholder(): string | null {
  const row = selectedRow()
  if (state.logError) return state.logError
  if (!state.path) return 'Choose a project to see its containers.'
  if (showingAll()) return containers().length ? null : 'No containers yet.'
  if (!row) return !state.servicesLoaded ? 'Loading…' : state.rows.length ? 'Choose a container.' : 'No containers.'
  if (!row.containerId) return 'This service has no container yet. Start it to create one.'
  return null
}

function renderLog(scrollToEnd = false): void {
  const pane = els.log
  const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32
  const row = selectedRow()
  const hasLog = showingAll() ? containers().length > 0 : !!row?.containerId
  els.logTitle.textContent = showingAll() ? 'Logs · all services' : row ? `Logs · ${row.name}` : 'Logs'
  els.clear.disabled = !hasLog
  els.cleared.hidden = !state.clearedAt
  els.clearedText.textContent = state.clearedAt ? `Lines before ${formatTime(state.clearedAt)} are hidden.` : ''
  pane.classList.toggle('wrap', els.wrap.checked)

  const fragment = document.createDocumentFragment()
  const placeholder = logPlaceholder()
  const shown = placeholder ? [] : visibleLines()
  if (placeholder) {
    fragment.append(el('div', 'placeholder', placeholder))
  } else {
    const filtered = els.filter.value.trim() !== '' || els.level.value !== 'all'
    if (state.truncated && !filtered) fragment.append(el('div', 'placeholder', 'Older lines are not shown.'))
    const withTime = els.timestamps.checked
    const sourceWidth = Math.max(0, ...shown.map((s) => s.line.src?.length ?? 0))
    const serviceByName = new Map(state.rows.map((r) => [r.name, r.service]))
    const selected = selectedRow()?.service ?? null
    for (const item of shown) {
      const service = item.line.src ? serviceByName.get(item.line.src) ?? null : selected
      fragment.append(renderLine(item, withTime, sourceWidth, service))
    }
    if (!shown.length) fragment.append(el('div', 'placeholder', filtered ? 'No lines match.' : 'No log lines yet.'))
  }
  els.ask.disabled = shown.length === 0
  els.save.disabled = shown.length === 0
  pane.replaceChildren(fragment)
  if (scrollToEnd || (els.follow.checked && atEnd)) pane.scrollTop = pane.scrollHeight
  if (unresolved.size) void resolveSources()
}

/** Asks the worker which queued stack trace paths are project files, then draws them as links. */
async function resolveSources(): Promise<void> {
  const path = state.path
  if (!path || resolving || !unresolved.size) return
  resolving = true
  const batch = [...unresolved].map(([service, files]) => [service, [...files].slice(0, 200)] as const)
  unresolved.clear()
  try {
    for (const [service, files] of batch) {
      let found: Record<string, string | null> = {}
      try {
        found = (await orca.plugin.request('code.resolve', { path, service, files })).files
      } catch {
        // Unknown stays text; not asking again keeps a failing worker from being called every render.
      }
      if (path !== state.path) return
      for (const file of files) sources.set(`${service}\0${file}`, found[file] ?? null)
    }
  } finally {
    resolving = false
  }
  renderLog()
}

// ---------- data ----------

function projectHint(): string | null {
  if (!state.workspaces) return null
  if (!state.workspaces.length) return 'No local Orca workspace has a compose file (compose.yaml, docker-compose.yml, …).'
  if (state.path) return null
  const focused = state.focused
  const noCompose = focused && !state.workspaces.some((w) => w.path === focused.path)
  return noCompose ? `No compose file in ${basename(focused.path)}. Choose a project above.` : 'Choose a project above.'
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
    else if (!state.notice?.error) setNotice(projectHint())
  } catch (error) {
    setNotice(errorText(error), true)
  }
}

function setPath(path: string | null): void {
  state.path = path
  setNotice(projectHint())
  state.project = ''
  state.rows = []
  state.servicesLoaded = false
  const last = path ? lastSelection.get(path) : undefined
  state.key = last?.key ?? null
  state.service = last?.service ?? null
  state.lines = []
  state.clearedAt = null
  state.logError = null
  state.stats = {}
  history.clear()
  sources.clear()
  unresolved.clear()
  state.confirmDown = false
  generation++
  renderWorkspaces()
  renderServices()
  renderLog(true)
  void loadServices()
}

function pickKey(rows: ServiceRow[]): { key: string; service: string | null } | null {
  if (state.key === ALL && rows.filter((r) => r.containerId).length >= 2) return { key: ALL, service: null }
  const row =
    rows.find((r) => r.key === state.key) ??
    rows.find((r) => r.service === state.service && r.containerId) ??
    rows.find((r) => r.service === state.service) ??
    rows.find((r) => r.state === 'running') ??
    rows[0]
  return row ? { key: row.key, service: row.service } : null
}

async function loadServices(fresh = false): Promise<void> {
  const path = state.path
  if (!path || servicesInFlight) return
  servicesInFlight = true
  const at = generation
  try {
    const { project, rows } = await orca.plugin.request('services.list', { path, fresh })
    if (path !== state.path) return
    state.project = project
    state.rows = rows
    const firstLoad = !state.servicesLoaded
    state.servicesLoaded = true
    if (state.notice?.error) setNotice(null)
    if (firstLoad) void loadStats()
    const pick = pickKey(rows)
    if (pick && pick.key !== state.key) selectKey(pick.key, pick.service)
    else {
      renderServices()
      if (at === generation) renderLog()
    }
  } catch (error) {
    if (path !== state.path) return
    state.rows = []
    state.servicesLoaded = true
    renderServices()
    setNotice(errorText(error), true)
    renderLog()
  } finally {
    servicesInFlight = false
  }
}

/** Best effort: a failed sample (a container that just stopped, say) leaves the numbers out until the next. */
async function loadStats(): Promise<void> {
  const path = state.path
  const containerIds = state.rows.flatMap((r) => (r.containerId && r.state === 'running' ? [r.containerId] : []))
  if (!path || statsInFlight) return
  if (!containerIds.length) {
    state.stats = {}
    return
  }
  statsInFlight = true
  try {
    const { stats } = await orca.plugin.request('stats.get', { path, containerIds }, { timeoutMs: 45_000 })
    if (path !== state.path) return
    state.stats = stats
    for (const [id, usage] of Object.entries(stats)) {
      const cpu = parsePercent(usage.cpu)
      const mem = parseBytes(usage.mem)
      if (cpu !== null && mem !== null) history.set(id, [...(history.get(id) ?? []), { cpu, mem }].slice(-HISTORY_SAMPLES))
    }
  } catch {
    if (path !== state.path) return
    state.stats = {}
  } finally {
    statsInFlight = false
  }
  renderServices()
}

function selectKey(key: string, service: string | null): void {
  const same = key === state.key
  state.key = key
  state.service = service
  if (state.path) lastSelection.set(state.path, { key, service })
  renderServices()
  if (same) return
  state.lines = []
  state.clearedAt = null
  state.truncated = false
  state.logError = null
  generation++
  renderLog(true)
  void loadLogs(true)
}

/** Where a container's log starts for the chosen period. */
function sinceFor(row: ServiceRow): string | undefined {
  const window = els.window.value
  if (window === 'start') return row.startedAt ?? undefined
  const span = WINDOWS[window]
  return span ? new Date(Date.now() - span).toISOString() : undefined
}

function logTargets(): LogTarget[] {
  const rows = showingAll() ? containers() : [selectedRow()].filter((r): r is ServiceRow => !!r?.containerId)
  return rows.map((r) => {
    const since = sinceFor(r)
    return { service: r.service, containerId: r.containerId as string, name: r.name, ...(since ? { since } : {}) }
  })
}

function sameLines(a: LogLine[], b: LogLine[]): boolean {
  if (a.length !== b.length) return false
  if (!a.length) return true
  const [a0, b0, a1, b1] = [a[0], b[0], a[a.length - 1], b[b.length - 1]]
  return a0.t === b0.t && a0.m === b0.m && a1.t === b1.t && a1.m === b1.m && a1.src === b1.src
}

async function loadLogs(force = false): Promise<void> {
  const path = state.path
  const targets = logTargets()
  if (!path || !targets.length || (logsInFlight && !force)) return
  logsInFlight = true
  const at = generation
  try {
    const answer = await orca.plugin.request('logs.get', { path, targets })
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

function openedTerminal(what: string): void {
  setNotice(`${what} opened in a new terminal tab.`)
}

async function act(row: ServiceRow, action: ServiceAction): Promise<void> {
  const path = state.path
  if (!path) return
  state.busy.add(row.key)
  renderServices()
  try {
    const { terminalId } = await orca.plugin.request(
      'service.action',
      { path, service: row.service, containerId: row.containerId, action },
      { timeoutMs: 70_000 }
    )
    if (terminalId) openedTerminal(`docker compose up${action === 'build' ? ' --build' : ''} ${row.service}`)
    else setNotice(null)
  } catch (error) {
    const verb = { start: 'Start', stop: 'Stop', restart: 'Restart', build: 'Rebuild' }[action]
    setNotice(`${verb} ${row.service} failed: ${errorText(error)}`, true)
  } finally {
    state.busy.delete(row.key)
    renderServices()
  }
  if (path !== state.path) return
  await loadServices()
  await loadLogs(true)
}

async function projectAct(action: ProjectAction): Promise<void> {
  const path = state.path
  if (!path || state.projectBusy) return
  if (action === 'down' && !state.confirmDown) {
    state.confirmDown = true
    renderProjectActions()
    clearTimeout(downTimer)
    downTimer = setTimeout(() => {
      state.confirmDown = false
      renderProjectActions()
    }, DOWN_CONFIRM_MS)
    return
  }
  clearTimeout(downTimer)
  state.confirmDown = false
  state.projectBusy = action
  renderProjectActions()
  try {
    const { terminalId } = await orca.plugin.request('project.action', { path, action }, { timeoutMs: 120_000 })
    if (terminalId) openedTerminal('docker compose up -d')
    else setNotice(action === 'down' ? 'Containers stopped and removed.' : 'Containers restarted.')
  } catch (error) {
    setNotice(`docker compose ${action} failed: ${errorText(error)}`, true)
  } finally {
    state.projectBusy = null
    renderProjectActions()
  }
  if (path !== state.path) return
  await loadServices()
  await loadLogs(true)
}

async function openShell(row: ServiceRow): Promise<void> {
  if (!state.path || !row.containerId) return
  try {
    await orca.plugin.request('container.shell', { path: state.path, containerId: row.containerId, name: row.name })
    openedTerminal(`A shell in ${row.name}`)
  } catch (error) {
    setNotice(`Could not open a shell: ${errorText(error)}`, true)
  }
}

async function openUrl(url: string): Promise<void> {
  try {
    await orca.shell.openExternal(url)
  } catch (error) {
    setNotice(`Could not open the browser: ${errorText(error)}`, true)
  }
}

async function openSource(service: string, link: { file: string; line: number; column?: number }): Promise<void> {
  if (!state.path) return
  try {
    const column = link.column ? { column: link.column } : {}
    await orca.plugin.request('code.open', { path: state.path, service, file: link.file, line: link.line, ...column })
  } catch (error) {
    setNotice(`Could not open ${link.file}: ${errorText(error)}`, true)
  }
}

function logSource(): string {
  const row = selectedRow()
  if (showingAll() || !row) return `all services of the compose project "${state.project}"`
  return `container "${row.name}" (service "${row.service}" of the compose project "${state.project}")`
}

async function askAgent(): Promise<void> {
  const path = state.path
  const shown = visibleLines()
  if (!path || !shown.length) return
  const lines = shown.map(({ line, text }) => `${line.t.slice(11, 23)} ${line.src ? `${line.src} | ` : ''}${text}`)
  els.ask.disabled = true
  try {
    const { agent } = await orca.plugin.request('agent.ask', { path, source: logSource(), lines })
    setNotice(`Started ${agent} with the last ${Math.min(lines.length, 300)} log lines.`)
  } catch (error) {
    setNotice(`Could not start the agent: ${errorText(error)}`, true)
  } finally {
    els.ask.disabled = false
  }
}

async function saveLog(): Promise<void> {
  const shown = visibleLines()
  if (!shown.length) return
  const data = shown.map(({ line, text }) => `${line.t} ${line.src ? `${line.src} | ` : ''}${text}`).join('\n') + '\n'
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const name = showingAll() ? state.project || 'compose' : selectedRow()?.name ?? 'container'
  try {
    await orca.files.saveAs({ suggestedName: `${name}-${stamp}.log`, mimeType: 'text/plain', data })
  } catch (error) {
    setNotice(`Could not save: ${errorText(error)}`, true)
  }
}

async function clearLogs(reset: boolean): Promise<void> {
  const services = [...new Set(logTargets().map((t) => t.service))]
  if (!state.path || !services.length) return
  try {
    const { clearedAt } = await orca.plugin.request('logs.clear', { path: state.path, services, reset })
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
const checkboxes = { follow: els.follow, timestamps: els.timestamps, wrap: els.wrap }
const selects = { level: els.level, window: els.window }

async function loadPrefs(): Promise<void> {
  try {
    const prefs = (await orca.storage.get(PREFS_KEY)) as Record<string, unknown> | null
    for (const [name, input] of Object.entries(checkboxes)) {
      if (typeof prefs?.[name] === 'boolean') input.checked = prefs[name] as boolean
    }
    for (const [name, select] of Object.entries(selects)) {
      const value = prefs?.[name]
      if (typeof value === 'string' && [...select.options].some((o) => o.value === value)) select.value = value
    }
  } catch {
    // Defaults from the markup stay.
  }
}

function savePrefs(): void {
  const prefs = {
    ...Object.fromEntries(Object.entries(checkboxes).map(([name, input]) => [name, input.checked])),
    ...Object.fromEntries(Object.entries(selects).map(([name, select]) => [name, select.value]))
  }
  void orca.storage.set(PREFS_KEY, prefs).catch(() => undefined)
}

// ---------- wiring ----------

els.refresh.append(icon('restart'))
els.save.append(icon('save'))
els.clear.append(icon('clear'))
els.ask.prepend(icon('agent'))
els.workspace.addEventListener('change', () => setPath(els.workspace.value || null))
els.refresh.addEventListener('click', () => {
  void refreshWorkspaces()
    .then(() => loadServices(true))
    .then(() => loadLogs(true))
})
els.up.addEventListener('click', () => void projectAct('up'))
els.restart.addEventListener('click', () => void projectAct('restart'))
els.down.addEventListener('click', () => void projectAct('down'))
els.ask.addEventListener('click', () => void askAgent())
els.save.addEventListener('click', () => void saveLog())
els.clear.addEventListener('click', () => void clearLogs(false))
els.showAll.addEventListener('click', () => void clearLogs(true))
els.filter.addEventListener('input', () => renderLog())
els.level.addEventListener('change', () => {
  savePrefs()
  renderLog(true)
})
els.window.addEventListener('change', () => {
  savePrefs()
  generation++
  state.lines = []
  renderLog(true)
  void loadLogs(true)
})
for (const input of Object.values(checkboxes)) {
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
  if (document.hidden) return
  void loadServices()
  void loadStats()
}, SERVICES_POLL_MS)

renderWorkspaces()
renderProjectActions()
renderLog()
void loadPrefs().then(() => {
  renderLog()
  // Fires once with the current context as it subscribes, then on every focus change.
  orca.on('workspace.changed', ({ context }) => {
    state.context = context
    void refreshWorkspaces()
  })
})
