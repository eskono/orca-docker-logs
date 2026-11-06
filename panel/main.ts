// The panel: compose services of the chosen project, their state, resources and actions, and the log
// of one container or of all of them.
import type {
  ContainerStats,
  ComposeOptions,
  DockerContext,
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
import { diagnosticLines } from '../src/diagnostics'
import { parseAnsi, type Style } from './ansi'
import { icon, type IconName } from './icons'
import { levelToken } from './levels'
import { findLinks, type LogLink } from './links'
import { parseBytes, parsePercent, sparkPoints } from './sparkline'
import { RequestGate } from './requests'
import { LogBuffer } from './log-buffer'
import { analyze, groupErrors, incidentLines, isCorrelation, matchesFilter, type Shown } from './log-model'
import { reconcileLog } from './log-view'
import { portAddress } from './ports'

type Orca = {
  on(event: 'workspace.changed', handler: (payload: { context: FocusContext }) => void): unknown
  plugin: {
    request<K extends keyof Requests>(
      name: K,
      input: Requests[K]['input'],
      options?: { timeoutMs?: number; signal?: AbortSignal }
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
  log: $<HTMLDivElement>('log'),
  context: $<HTMLDivElement>('docker-context'),
  compose: $<HTMLDetailsElement>('compose-settings'),
  composeForm: $<HTMLFormElement>('compose-form'),
  composeFiles: $<HTMLTextAreaElement>('compose-files'),
  composeProfiles: $<HTMLInputElement>('compose-profiles'),
  availableProfiles: $<HTMLSpanElement>('available-profiles'),
  composeApply: $<HTMLButtonElement>('compose-apply'),
  diagnostics: $<HTMLDetailsElement>('diagnostics'),
  diagnosticTitle: $<HTMLElement>('diagnostic-title'),
  diagnosticBody: $<HTMLDivElement>('diagnostic-body'),
  group: $<HTMLInputElement>('group-errors'),
  json: $<HTMLInputElement>('json-fields'),
  copy: $<HTMLButtonElement>('copy'),
  resize: $<HTMLDivElement>('services-resize')
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
  stats: {} as Record<string, ContainerStats>,
  dockerContext: { name: 'unknown', endpoint: '', remote: false } as DockerContext,
  options: { files: [], profiles: [] } as ComposeOptions,
  availableProfiles: [] as string[],
  logWarnings: [] as string[],
  limits: [] as string[]
}
/** The row last viewed in each project, picked again when the project comes back. */
const lastSelection = new Map<string, { key: string; service: string | null }>()
/** Log rendering scope: navigation and Clear must not reuse nodes from a previous selection. */
let generation = 0
const serviceRequests = new RequestGate()
const logRequests = new RequestGate()
const statRequests = new RequestGate()
const focusRequests = new RequestGate()
const configRequests = new RequestGate()
const buffer = new LogBuffer()
let sourceRevision = 0
let pathRevision = 0
let clearing = false
let asking = false

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
    if (row.state === 'running' && row.portBindings.length) {
      const ports = el('span', 'ports')
      const seen = new Set<number>()
      for (const binding of row.portBindings) {
        if (seen.has(binding.port) || seen.size >= 4) continue
        seen.add(binding.port)
        const { address, url } = portAddress(binding, state.dockerContext)
        const link = el('button', 'port', `:${binding.port}`)
        link.title = `Copy ${address}`
        link.addEventListener('click', () => void copyText(address))
        ports.append(link)
        if (url) {
          const open = el('button', 'port', '↗')
          open.title = `Open ${url}`
          open.setAttribute('aria-label', open.title)
          open.addEventListener('click', () => void openUrl(url))
          ports.append(open)
        }
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
  renderDiagnostics()
}

function renderDiagnostics(): void {
  const rows = showingAll() ? containers() : [selectedRow()].filter((row): row is ServiceRow => !!row)
  els.diagnostics.hidden = rows.length === 0
  const problems = rows.map((row) => problemOf(row)).filter(Boolean)
  els.diagnosticTitle.textContent = problems.length ? `Diagnostics · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'Container diagnostics'
  els.diagnostics.classList.toggle('has-problem', problems.length > 0)
  const content = rows.map((row) => el('pre', undefined, diagnosticLines(row).join('\n')))
  els.diagnosticBody.replaceChildren(...content)
  els.context.textContent = `Docker: ${state.dockerContext.name}${state.dockerContext.remote ? ' · remote' : ''}`
  els.context.title = state.dockerContext.endpoint || 'Docker context could not be determined'
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

let levelCache: { lines: LogLine[]; shown: Shown[] } | null = null

/** Every line with its plain text and level, computed once per answer from the worker. */
function analyzed(): Shown[] {
  if (levelCache?.lines !== state.lines) {
    levelCache = { lines: state.lines, shown: analyze(state.lines) }
  }
  return levelCache.shown
}

/** The lines the level and filter let through. */
function visibleLines(): Shown[] {
  const filter = els.filter.value.trim()
  const level = els.level.value
  return analyzed().filter((item) =>
    (level === 'all' || item.level === 'error' || (level === 'warn' && item.level === 'warn')) &&
    (!filter || matchesFilter(item, filter))
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

function renderLine({ line, level, fields, count }: Shown, withTime: boolean, sourceWidth: number, service: string | null): HTMLElement {
  const node = el('div', ['line', line.e ? 'err' : '', level ? `lvl-${level}` : ''].filter(Boolean).join(' '))
  if (withTime && line.t) node.append(el('span', 'ts', `${formatTime(line.t)} `))
  if (line.src) node.append(el('span', `src f${sourceColor(line.src)}`, `${line.src.padEnd(sourceWidth)} │ `))
  if (count > 1) node.append(el('span', 'repeat-count', `×${count} `))
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
  if (els.json.checked && fields) {
    const details = el('details', 'json-fields')
    details.append(el('summary', undefined, 'JSON fields'))
    const list = el('dl')
    for (const [key, value] of Object.entries(fields)) {
      list.append(el('dt', undefined, key))
      const entry = el('dd')
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (isCorrelation(key) && typeof value !== 'object') {
        const filter = el('button', 'link', text)
        filter.title = `Filter by ${key}`
        filter.addEventListener('click', () => { els.filter.value = `${key}=${JSON.stringify(String(value))}`; renderLog(true) })
        entry.append(filter)
      } else entry.textContent = text
      list.append(entry)
    }
    details.append(list)
    node.append(details)
  }
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
  els.clear.disabled = !hasLog || clearing
  els.showAll.disabled = clearing
  els.cleared.hidden = !state.clearedAt
  els.clearedText.textContent = state.clearedAt ? `Lines before ${formatTime(state.clearedAt)} are hidden.` : ''
  pane.classList.toggle('wrap', els.wrap.checked)
  const entries: { key: string; create: () => HTMLElement }[] = []
  const placeholder = logPlaceholder()
  const shown = placeholder ? [] : visibleLines()
  if (placeholder) entries.push({ key: `placeholder:${placeholder}`, create: () => el('div', 'placeholder', placeholder) })
  else {
    if (state.truncated) {
      const text = `Partial history: older lines were omitted (${state.limits.join(', ') || 'history limit'}). Save and Ask agent use the loaded lines.`
      entries.push({ key: text, create: () => el('div', 'placeholder', text) })
    }
    for (const warning of state.logWarnings) entries.push({ key: `warning:${warning}`, create: () => el('div', 'placeholder log-warning', warning) })
    const records = els.group.checked ? groupErrors(shown) : shown
    const sourceWidth = Math.max(0, ...records.map((item) => item.line.src?.length ?? 0))
    const serviceByName = new Map(state.rows.map((r) => [r.name, r.service]))
    const serviceById = new Map(state.rows.map((r) => [r.containerId, r.service]))
    for (const item of records) {
      const service = item.line.containerId ? serviceById.get(item.line.containerId) ?? null : item.line.src ? serviceByName.get(item.line.src) ?? null : row?.service ?? null
      const key = JSON.stringify([item.line, item.level, item.count, els.timestamps.checked, els.json.checked, sourceWidth, sourceRevision, generation, service])
      entries.push({ key, create: () => renderLine(item, els.timestamps.checked, sourceWidth, service) })
    }
    if (!records.length) {
      const text = els.filter.value.trim() || els.level.value !== 'all' ? 'No lines match.' : 'No log lines yet.'
      entries.push({ key: text, create: () => el('div', 'placeholder', text) })
    }
  }
  els.ask.disabled = asking || shown.length === 0
  els.save.disabled = shown.length === 0
  els.copy.disabled = shown.length === 0
  reconcileLog(pane, entries)
  if (scrollToEnd || (els.follow.checked && atEnd)) pane.scrollTop = pane.scrollHeight
  if (unresolved.size) void resolveSources()
}

/** Asks the worker which queued stack trace paths are project files, then draws them as links. */
async function resolveSources(): Promise<void> {
  const path = state.path
  if (!path || resolving || !unresolved.size) return
  resolving = true
  const revision = pathRevision
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
      if (path !== state.path || revision !== pathRevision) return
      sourceRevision++
      for (const file of files) sources.set(`${service}\0${file}`, found[file] ?? null)
    }
  } finally {
    resolving = false
    if (unresolved.size) queueMicrotask(() => void resolveSources())
  }
  if (revision === pathRevision) renderLog()
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
  const ticket = focusRequests.begin(true)!
  try {
    const { workspaces, focused } = await orca.plugin.request('workspaces.list', { context: state.context }, { signal: ticket.signal })
    if (!focusRequests.current(ticket)) return
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
    if (focusRequests.current(ticket)) setNotice(errorText(error), true)
  } finally { focusRequests.finish(ticket) }
}

function resetLogs(): void {
  generation++
  logRequests.invalidate()
  buffer.reset()
  state.lines = []
  state.clearedAt = null
  state.truncated = false
  state.logError = null
  state.logWarnings = []
  state.limits = []
}
let clearOperation = 0
let projectOperation = 0
function setPath(path: string | null): void {
  state.path = path
  pathRevision++
  clearOperation++
  projectOperation++
  clearing = false
  state.projectBusy = null
  state.busy.clear()
  for (const lane of [serviceRequests, statRequests, configRequests]) lane.invalidate()
  resetLogs()
  setNotice(projectHint())
  state.project = ''
  state.rows = []
  state.servicesLoaded = false
  state.options = { files: [], profiles: [] }
  state.availableProfiles = []
  state.dockerContext = { name: 'loading…', endpoint: '', remote: false }
  const last = path ? lastSelection.get(path) : undefined
  state.key = last?.key ?? null
  state.service = last?.service ?? null
  state.stats = {}
  history.clear()
  sources.clear()
  unresolved.clear()
  sourceRevision++
  state.confirmDown = false
  clearTimeout(downTimer)
  els.composeFiles.value = ''
  els.composeProfiles.value = ''
  els.availableProfiles.textContent = ''
  els.composeApply.disabled = !path
  renderWorkspaces()
  renderServices()
  renderLog(true)
  if (path) void loadComposeOptions()
  void loadServices()
}

async function loadComposeOptions(): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = configRequests.begin(true)!
  try {
    const { options } = await orca.plugin.request('compose.get', { path }, { signal: ticket.signal })
    if (!configRequests.current(ticket)) return
    state.options = options
    els.composeFiles.value = options.files.join('\n')
    els.composeProfiles.value = options.profiles.join(', ')
  } catch (error) {
    if (configRequests.current(ticket)) setNotice(`Could not read Compose settings: ${errorText(error)}`, true)
  } finally { configRequests.finish(ticket) }
}

async function applyCompose(event: Event): Promise<void> {
  event.preventDefault()
  const path = state.path
  if (!path) return
  const ticket = configRequests.begin(true)!
  els.composeApply.disabled = true
  const options = {
    files: els.composeFiles.value.split('\n').map((file) => file.trim()).filter(Boolean),
    profiles: els.composeProfiles.value.split(',').map((profile) => profile.trim()).filter(Boolean)
  }
  try {
    await orca.plugin.request('compose.set', { path, options }, { timeoutMs: 60_000, signal: ticket.signal })
    if (!configRequests.current(ticket)) return
    setPath(path)
    setNotice('Compose settings saved for this workspace.')
    void refreshWorkspaces()
  } catch (error) {
    if (configRequests.current(ticket)) setNotice(`Could not apply Compose settings: ${errorText(error)}`, true)
  } finally {
    if (configRequests.current(ticket)) els.composeApply.disabled = false
    configRequests.finish(ticket)
  }
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
  if (!path) return
  const ticket = serviceRequests.begin(fresh)
  if (!ticket) return
  try {
    const answer = await orca.plugin.request('services.list', { path, fresh }, { timeoutMs: 70_000, signal: ticket.signal })
    if (!serviceRequests.current(ticket)) return
    const beforeTargets = JSON.stringify(logTargets().map((target) => target.containerId))
    const contextChanged = state.dockerContext.name !== answer.context.name || state.dockerContext.endpoint !== answer.context.endpoint
    state.project = answer.project
    state.rows = answer.rows
    state.dockerContext = answer.context
    state.availableProfiles = answer.profiles
    els.availableProfiles.textContent = answer.profiles.length ? `Available profiles: ${answer.profiles.join(', ')}` : 'No optional profiles'
    const firstLoad = !state.servicesLoaded
    state.servicesLoaded = true
    if (state.notice?.error) setNotice(null)
    if (contextChanged) { history.clear(); state.stats = {}; statRequests.invalidate() }
    const pick = pickKey(answer.rows)
    if (pick && pick.key !== state.key) selectKey(pick.key, pick.service)
    else {
      const changed = beforeTargets !== JSON.stringify(logTargets().map((target) => target.containerId))
      if (changed || contextChanged) resetLogs()
      renderServices()
      renderLog()
      if (firstLoad || changed || contextChanged) void loadLogs(true)
    }
    if (firstLoad || contextChanged) void loadStats()
    const ids = new Set(answer.rows.map((row) => row.containerId))
    for (const id of history.keys()) if (!ids.has(id)) history.delete(id)
  } catch (error) {
    if (!serviceRequests.current(ticket)) return
    state.servicesLoaded = true
    renderServices()
    setNotice(errorText(error), true)
    els.compose.open = true
    renderLog()
  } finally { serviceRequests.finish(ticket) }
}

async function loadStats(): Promise<void> {
  const path = state.path
  const containerIds = state.rows.flatMap((row) => row.containerId && row.state === 'running' ? [row.containerId] : [])
  if (!path) return
  const ticket = statRequests.begin()
  if (!ticket) return
  try {
    if (!containerIds.length) { state.stats = {}; return }
    const { stats } = await orca.plugin.request('stats.get', { path, containerIds }, { timeoutMs: 45_000, signal: ticket.signal })
    if (!statRequests.current(ticket)) return
    state.stats = stats
    for (const [id, usage] of Object.entries(stats)) {
      const cpu = parsePercent(usage.cpu), mem = parseBytes(usage.mem)
      if (cpu !== null && mem !== null) history.set(id, [...(history.get(id) ?? []), { cpu, mem }].slice(-HISTORY_SAMPLES))
    }
    renderServices()
  } catch {
    if (statRequests.current(ticket)) { state.stats = {}; renderServices() }
  } finally { statRequests.finish(ticket) }
}

function selectKey(key: string, service: string | null): void {
  const same = key === state.key
  state.key = key
  state.service = service
  if (state.path) lastSelection.set(state.path, { key, service })
  renderServices()
  if (same) return
  resetLogs()
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
  return a.length === b.length && a.every((line, i) => {
    const other = b[i]
    return line.t === other.t && line.m === other.m && line.e === other.e && line.src === other.src && line.containerId === other.containerId
  })
}

async function loadLogs(force = false): Promise<void> {
  const path = state.path
  const baseTargets = logTargets()
  if (!path || !baseTargets.length || clearing) return
  const ticket = logRequests.begin(force)
  if (!ticket) return
  const targets = force ? baseTargets : buffer.targets(baseTargets)
  try {
    const answer = await orca.plugin.request('logs.get', { path, targets }, { timeoutMs: 60_000, signal: ticket.signal })
    if (!logRequests.current(ticket)) return
    buffer.apply(answer, baseTargets, !force, els.window.value === 'tail')
    const warnings = buffer.errors.map((error) => `${error.name}: ${error.message}`)
    const limits = [...buffer.limits]
    const changed = !sameLines(buffer.lines, state.lines) || state.clearedAt !== buffer.clearedAt || state.truncated !== buffer.truncated || state.logError !== null || JSON.stringify(warnings) !== JSON.stringify(state.logWarnings) || JSON.stringify(limits) !== JSON.stringify(state.limits)
    state.lines = buffer.lines
    state.clearedAt = buffer.clearedAt
    state.truncated = buffer.truncated
    state.logWarnings = warnings
    state.limits = limits
    state.logError = null
    if (changed || force) renderLog(force)
  } catch (error) {
    if (!logRequests.current(ticket)) return
    state.logError = errorText(error)
    renderLog()
  } finally { logRequests.finish(ticket) }
}

function openedTerminal(what: string): void {
  setNotice(`${what} opened in a new terminal tab.`)
}

async function act(row: ServiceRow, action: ServiceAction): Promise<void> {
  const path = state.path
  const revision = pathRevision
  if (!path || state.busy.has(row.key)) return
  state.busy.add(row.key)
  renderServices()
  try {
    const { terminalId } = await orca.plugin.request(
      'service.action',
      { path, service: row.service, containerId: row.containerId, action },
      { timeoutMs: 70_000 }
    )
    if (revision !== pathRevision) return
    if (terminalId) openedTerminal(`docker compose up${action === 'build' ? ' --build' : ''} ${row.service}`)
    else setNotice(null)
  } catch (error) {
    if (revision !== pathRevision) return
    const verb = { start: 'Start', stop: 'Stop', restart: 'Restart', build: 'Rebuild' }[action]
    setNotice(`${verb} ${row.service} failed: ${errorText(error)}`, true)
  } finally {
    if (revision === pathRevision) { state.busy.delete(row.key); renderServices() }
  }
  if (revision !== pathRevision) return
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
  const operation = ++projectOperation
  state.projectBusy = action
  renderProjectActions()
  try {
    const { terminalId } = await orca.plugin.request('project.action', { path, action }, { timeoutMs: 120_000 })
    if (operation !== projectOperation) return
    if (terminalId) openedTerminal('docker compose up -d')
    else setNotice(action === 'down' ? 'Containers stopped and removed.' : 'Containers restarted.')
  } catch (error) {
    if (operation !== projectOperation) return
    setNotice(`docker compose ${action} failed: ${errorText(error)}`, true)
  } finally {
    if (operation === projectOperation) { state.projectBusy = null; renderProjectActions() }
  }
  if (operation !== projectOperation) return
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
  const revision = pathRevision
  const shown = visibleLines()
  if (!path || !shown.length || asking) return
  const incident = incidentLines(analyzed(), shown)
  const lines: string[] = []
  let chars = 0
  for (const { line, text } of incident) {
    const formatted = `${line.t} ${line.src ? `${line.src} | ` : ''}${text}`.slice(0, 23_999)
    if (chars + formatted.length + 1 > 24_000) break
    lines.push(formatted); chars += formatted.length + 1
  }
  const containerIds = [...new Set(incident.flatMap((item) => item.line.containerId ? [item.line.containerId] : []))]
  asking = true
  els.ask.disabled = true
  try {
    const { agent, linesSent } = await orca.plugin.request('agent.ask', { path, source: logSource(), lines, containerIds }, { timeoutMs: 70_000 })
    if (revision === pathRevision) setNotice(`Started ${agent} with ${linesSent} log lines, surrounding context and container diagnostics.`)
  } catch (error) {
    if (revision === pathRevision) setNotice(`Could not start the agent: ${errorText(error)}`, true)
  } finally { asking = false; renderLog() }
}

async function copyText(text: string): Promise<void> {
  try {
    let copied = false
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true }
    } catch { /* Some embedded frames expose the Clipboard API but deny it; try the selection API. */ }
    if (!copied) {
      const active = document.activeElement as HTMLElement | null
      const selection = window.getSelection()
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
      const area = el('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      try { area.select(); copied = document.execCommand('copy') }
      finally {
        area.remove()
        active?.focus()
        selection?.removeAllRanges()
        for (const range of ranges) selection?.addRange(range)
      }
      if (!copied) throw new Error('Clipboard is unavailable')
    }
    setNotice('Copied to clipboard.')
  } catch (error) { setNotice(`Could not copy: ${errorText(error)}`, true) }
}

function copyLog(): void {
  const selection = window.getSelection()
  const selected = selection && selection.anchorNode && selection.focusNode && els.log.contains(selection.anchorNode) && els.log.contains(selection.focusNode) ? selection.toString() : ''
  void copyText(selected || visibleLines().map(({ line, text }) => `${line.t} ${line.src ? `${line.src} | ` : ''}${text}`).join('\n'))
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
  const path = state.path
  const services = [...new Set(logTargets().map((target) => target.service))]
  if (!path || !services.length || clearing) return
  const operation = ++clearOperation
  resetLogs()
  clearing = true
  renderLog(true)
  try {
    const { clearedAt } = await orca.plugin.request('logs.clear', { path, services, reset })
    if (operation !== clearOperation) return
    state.clearedAt = clearedAt
    clearing = false
    renderLog(true)
    await loadLogs(true)
  } catch (error) {
    if (operation === clearOperation) setNotice(errorText(error), true)
  } finally {
    if (operation === clearOperation) { clearing = false; renderLog() }
  }
}

// ---------- preferences ----------

const PREFS_KEY = 'prefs'
const checkboxes = { follow: els.follow, timestamps: els.timestamps, wrap: els.wrap, group: els.group, json: els.json }
let servicesHeight: number | null = null
const selects = { level: els.level, window: els.window }

async function loadPrefs(): Promise<void> {
  try {
    const prefs = (await orca.storage.get(PREFS_KEY)) as Record<string, unknown> | null
    if (typeof prefs?.servicesHeight === 'number') setServicesHeight(prefs.servicesHeight)
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
    servicesHeight,
    ...Object.fromEntries(Object.entries(checkboxes).map(([name, input]) => [name, input.checked])),
    ...Object.fromEntries(Object.entries(selects).map(([name, select]) => [name, select.value]))
  }
  void orca.storage.set(PREFS_KEY, prefs).catch(() => undefined)
}

function setServicesHeight(height: number): void {
  const maximum = Math.max(80, (document.body.clientHeight || 600) * 0.6)
  servicesHeight = Math.round(Math.max(48, Math.min(height, maximum)))
  els.services.style.height = `${servicesHeight}px`
  els.resize.setAttribute('aria-valuenow', String(servicesHeight))
  els.resize.setAttribute('aria-valuemax', String(Math.round(maximum)))
}
els.resize.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  setServicesHeight((servicesHeight ?? els.services.getBoundingClientRect().height) + (event.key === 'ArrowDown' ? 16 : -16))
  savePrefs()
})
els.resize.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  const top = els.services.getBoundingClientRect().top
  const move = (pointer: PointerEvent) => setServicesHeight(pointer.clientY - top)
  const end = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); savePrefs() }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', end)
  document.addEventListener('pointercancel', end)
})

// ---------- wiring ----------

els.refresh.append(icon('restart'))
els.save.append(icon('save'))
els.clear.append(icon('clear'))
els.copy.addEventListener('click', copyLog)
els.composeForm.addEventListener('submit', (event) => void applyCompose(event))
$('compose-defaults').addEventListener('click', () => { els.composeFiles.value = ''; els.composeProfiles.value = ''; els.composeForm.requestSubmit() })
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
  resetLogs()
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
