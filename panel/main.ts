// The panel: compose services of the chosen project, their state, resources and actions, and the log
// of one container or of all of them.
import type {
  ContainerStats,
  ComposeOptions,
  ComposeRuntime,
  DockerContext,
  FocusContext,
  LogLine,
  LogTarget,
  Operation,
  ContainerEvent,
  EventHistory,
  SavedView,
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
import { analyze, logRecords, incidentLines, isCorrelation, matchesFilter, type Shown } from './log-model'
import { reconcileLog } from './log-view'
import { portAddress } from './ports'
import { findMatches, highlightMatches, revealLogNode, SearchNavigation } from './search'
import { renderOperations } from './operations-view'
import { traceLines } from './traces'

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
const GROUP = 'selection'
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
  composeEnvFile: $<HTMLInputElement>('compose-env-file'),
  composeEnvFiles: $<HTMLDataListElement>('compose-env-files'),
  composeProfileMode: $<HTMLSelectElement>('compose-profile-mode'),
  composeRuntime: $<HTMLDivElement>('compose-runtime'),
  composeApply: $<HTMLButtonElement>('compose-apply'),
  composeDiscovered: $<HTMLDivElement>('compose-discovered'),
  composeDiscoveryStatus: $<HTMLSpanElement>('compose-discovery-status'),
  composeRescan: $<HTMLButtonElement>('compose-rescan'),
  composeProfileChoices: $<HTMLDivElement>('compose-profile-choices'),
  composeProfileStatus: $<HTMLSpanElement>('compose-profile-status'),
  diagnostics: $<HTMLDetailsElement>('diagnostics'),
  diagnosticTitle: $<HTMLElement>('diagnostic-title'),
  diagnosticBody: $<HTMLDivElement>('diagnostic-body'),
  group: $<HTMLInputElement>('group-errors'),
  json: $<HTMLInputElement>('json-fields'),
  copy: $<HTMLButtonElement>('copy'),
  resize: $<HTMLDivElement>('services-resize'),
  search: $<HTMLInputElement>('search'),
  searchCount: $<HTMLSpanElement>('search-count'),
  searchPrevious: $<HTMLButtonElement>('search-previous'),
  searchNext: $<HTMLButtonElement>('search-next'),
  errorPrevious: $<HTMLButtonElement>('error-previous'),
  errorNext: $<HTMLButtonElement>('error-next'),
  operations: $<HTMLDetailsElement>('operations'),
  operationsTitle: $<HTMLSpanElement>('operations-title'),
  operationsList: $<HTMLDivElement>('operations-list'),
  events: $<HTMLDetailsElement>('events'),
  eventsTitle: $<HTMLSpanElement>('events-title'),
  eventsList: $<HTMLDivElement>('events-list'),
  live: $<HTMLButtonElement>('live'),
  savedView: $<HTMLSelectElement>('saved-view'),
  viewName: $<HTMLInputElement>('view-name'),
  viewSave: $<HTMLButtonElement>('view-save'),
  viewDelete: $<HTMLButtonElement>('view-delete')
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
  runtime: null as ComposeRuntime | null,
  logWarnings: [] as string[],
  limits: [] as string[],
  operations: [] as Operation[],
  events: null as EventHistory | null,
  selectedServices: null as string[] | null
}
/** The row last viewed in each project, picked again when the project comes back. */
const lastSelection = new Map<string, { key: string; service: string | null; services: string[] | null }>()
/** Log rendering scope: navigation and Clear must not reuse nodes from a previous selection. */
let generation = 0
const serviceRequests = new RequestGate()
const logRequests = new RequestGate()
const statRequests = new RequestGate()
const focusRequests = new RequestGate()
const configRequests = new RequestGate()
const discoveryRequests = new RequestGate()
const profileRequests = new RequestGate()
let discoveredFiles: string[] = []
let previewProfiles: string[] = []
let composeEdited = false
let previewRuntime: ComposeRuntime | null = null
const operationRequests = new RequestGate()
const eventRequests = new RequestGate()
const viewRequests = new RequestGate()
let views: SavedView[] = []
let viewsLoaded = false
let viewsSaving = false
const buffer = new LogBuffer()
let sourceRevision = 0
let pathRevision = 0
let clearing = false
let asking = false
const searchNavigation = new SearchNavigation()
let searchLimited = false
let lastErrorNode: HTMLElement | null = null
let eventRange: { since: string; until: string } | null = null
const expandedTraces = new Map<string, boolean>()

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
const selectedRows = () => showingAll() ? state.rows : state.key === GROUP ? state.rows.filter((r) => state.selectedServices?.includes(r.service)) : state.rows.filter((r) => r.key === state.key)
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
  const operation = state.operations.find((operation) => operation.status === 'running' && (!operation.service || operation.service === row.service))
  if (operation) return `${operation.title}…`
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
  const idle = !!state.path && state.runtime?.enabledServices.length !== 0 && state.servicesLoaded && !state.projectBusy && !state.operations.some((operation) => operation.status === 'running')
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
    const selected = row.key === state.key || state.key === GROUP && !!state.selectedServices?.includes(row.service)
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
    const check = el('input', 'service-select')
    check.type = 'checkbox'
    check.checked = selectedRows().some((r) => r.service === row.service)
    check.setAttribute('aria-label', `Include ${row.service} in combined logs`)
    check.addEventListener('change', () => {
      const services = new Set(selectedRows().map((r) => r.service))
      if (check.checked) services.add(row.service)
      else services.delete(row.service)
      selectKey(GROUP, null, [...services].sort())
    })
    item.append(check, pick)

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
    for (const [name, label, onPress] of rowActions(row)) actions.append(iconButton(name, label, onPress, state.busy.has(row.key) || !!state.projectBusy || state.operations.some((operation) => operation.status === 'running' && (!operation.service || operation.service === row.service))))
    item.append(actions)
    return item
  })
  const all = renderAllRow()
  els.services.replaceChildren(...(all ? [all] : []), ...items)
  renderProjectActions()
  renderDiagnostics()
}

function renderDiagnostics(): void {
  const rows = selectedRows()
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

function appendLogText(target: HTMLElement, raw: string, service: string | null): void {
  const segments = parseAnsi(raw)
  const plain = (piece: string) => document.createTextNode(piece)
  if (segments.every((s) => Object.keys(s.style).length === 0)) {
    // Most programs drop their colours when Docker, not a terminal, reads their output: colour the
    // level word ourselves so INFO, WARNING and ERROR still stand out.
    const text = segments.map((s) => s.text).join('')
    const token = levelToken(text)
    if (token) {
      target.append(
        ...linkified(text.slice(0, token.start), plain, service),
        el('span', `level-word ${token.tone}`, text.slice(token.start, token.end)),
        ...linkified(text.slice(token.end), plain, service)
      )
    } else if (text) {
      target.append(...linkified(text, plain, service))
    }
  } else {
    for (const segment of segments) target.append(...linkified(segment.text, (piece) => styled(piece, segment.style), service))
  }
}

function renderLine({ line, level, fields, count }: Shown, withTime: boolean, sourceWidth: number, service: string | null, searchLimit = 0): HTMLElement {
  const node = el('div', ['line', line.e ? 'err' : '', level ? `lvl-${level}` : ''].filter(Boolean).join(' '))
  if (withTime && line.t) node.append(el('span', 'ts', `${formatTime(line.t)} `))
  if (line.src) node.append(el('span', `src f${sourceColor(line.src)}`, `${line.src.padEnd(sourceWidth)} │ `))
  if (count > 1) node.append(el('span', 'repeat-count', `×${count} `))
  const message = el('span', 'log-message')
  const trace = traceLines(line.m, (file) => sources.get(`${service}\0${file}`))
  const physical = line.m.split('\n')
  const first = trace?.findIndex((part) => part.frame) ?? -1
  let last = trace ? trace.findLastIndex((part) => part.frame) : -1
  while (last >= 0 && last + 1 < physical.length && /^\s+\S/.test(physical[last + 1])) last++
  const traceKey = JSON.stringify([generation, line.containerId, line.src, line.t, line.m])
  const appendLines = (target: HTMLElement, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const part = el('span', trace?.[i].frame ? `trace-frame trace-${trace[i].kind}` : undefined)
      appendLogText(part, physical[i], service)
      target.append(part)
      if (i < physical.length - 1) target.append('\n')
    }
  }
  if (first >= 0 && trace) {
    appendLines(message, 0, first)
    const details = el('details', 'trace')
    const frames = trace.filter((part) => part.frame)
    const project = frames.filter((part) => part.kind === 'project').length
    const library = frames.filter((part) => part.kind === 'library').length
    const summary = el('summary', undefined, `${frames.length} stack frames · ${project} project · ${library} library`)
    summary.setAttribute('data-search-ignore', '')
    details.open = expandedTraces.get(traceKey) ?? false
    details.addEventListener('toggle', () => {
      expandedTraces.set(traceKey, details.open)
      if (expandedTraces.size > 1000) expandedTraces.delete(expandedTraces.keys().next().value!)
    })
    details.append(summary)
    appendLines(details, first, last + 1)
    message.append(details)
    appendLines(message, last + 1, physical.length)
  } else appendLines(message, 0, physical.length)
  if (message.childNodes.length === 0) message.append('​') // keep empty lines one line tall
  if (searchLimit) highlightMatches(message, els.search.value, searchLimit)
  node.append(message)
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
  if (showingAll() || state.key === GROUP) return selectedRows().some((r) => r.containerId) ? null : 'No containers for these services yet.'
  if (!row) return !state.servicesLoaded ? 'Loading…' : state.rows.length ? 'Choose a container.' : 'No containers.'
  if (!row.containerId) return 'This service has no container yet. Start it to create one.'
  return null
}

function renderLog(scrollToEnd = false): void {
  const pane = els.log
  const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32
  const row = selectedRow()
  const hasLog = selectedRows().some((r) => r.containerId)
  els.logTitle.textContent = showingAll() ? 'Logs · all services' : state.key === GROUP ? `Logs · ${state.selectedServices?.join(', ') || 'no services'}` : row ? `Logs · ${row.name}` : 'Logs'
  els.live.hidden = !eventRange
  els.clear.disabled = !hasLog || clearing
  els.showAll.disabled = clearing
  els.cleared.hidden = !state.clearedAt
  els.clearedText.textContent = state.clearedAt ? `Lines before ${formatTime(state.clearedAt)} are hidden.` : ''
  pane.classList.toggle('wrap', els.wrap.checked)
  const entries: { key: string; create: () => HTMLElement }[] = []
  let searchBudget = 1000
  searchLimited = false
  const placeholder = logPlaceholder()
  const shown = placeholder ? [] : visibleLines()
  if (placeholder) entries.push({ key: `placeholder:${placeholder}`, create: () => el('div', 'placeholder', placeholder) })
  else {
    if (state.truncated) {
      const text = `Partial history: older lines were omitted (${state.limits.join(', ') || 'history limit'}). Save and Ask agent use the loaded lines.`
      entries.push({ key: text, create: () => el('div', 'placeholder', text) })
    }
    for (const warning of state.logWarnings) entries.push({ key: `warning:${warning}`, create: () => el('div', 'placeholder log-warning', warning) })
    const records = logRecords(shown, els.group.checked)
    const sourceWidth = Math.max(0, ...records.map((item) => item.line.src?.length ?? 0))
    const serviceByName = new Map(state.rows.map((r) => [r.name, r.service]))
    const serviceById = new Map(state.rows.map((r) => [r.containerId, r.service]))
    for (const item of records) {
      const service = item.line.containerId ? serviceById.get(item.line.containerId) ?? null : item.line.src ? serviceByName.get(item.line.src) ?? null : row?.service ?? null
      const matches = findMatches(item.text, els.search.value, searchBudget + 1)
      const searchLimit = Math.min(searchBudget, matches.length)
      searchLimited ||= matches.length > searchBudget
      searchBudget -= searchLimit
      const key = JSON.stringify([item.line, item.level, item.count, els.timestamps.checked, els.json.checked, sourceWidth, sourceRevision, generation, service, els.search.value, searchLimit])
      entries.push({ key, create: () => renderLine(item, els.timestamps.checked, sourceWidth, service, searchLimit) })
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
  searchNavigation.refresh(pane)
  renderSearchCount()
  if (scrollToEnd || (els.follow.checked && atEnd && !els.search.value)) pane.scrollTop = pane.scrollHeight
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
  for (const lane of [serviceRequests, statRequests, configRequests, discoveryRequests, profileRequests, operationRequests, eventRequests, viewRequests]) lane.invalidate()
  resetLogs()
  setNotice(projectHint())
  state.project = ''
  state.rows = []
  state.servicesLoaded = false
  state.options = { files: [], profiles: [] }
  state.runtime = null
  els.composeRuntime.textContent = ''
  state.dockerContext = { name: 'loading…', endpoint: '', remote: false }
  const last = path ? lastSelection.get(path) : undefined
  eventRange = null
  expandedTraces.clear()
  state.selectedServices = last?.services ?? null
  state.key = last?.key ?? null
  state.service = last?.service ?? null
  state.stats = {}
  state.operations = []
  views = []
  viewsLoaded = false
  viewsSaving = false
  els.savedView.value = ''
  els.viewName.value = ''
  renderViews()
  state.events = null
  els.eventsList.replaceChildren()
  els.eventsTitle.textContent = 'Container events'
  els.operations.hidden = true
  history.clear()
  sources.clear()
  unresolved.clear()
  sourceRevision++
  state.confirmDown = false
  clearTimeout(downTimer)
  discoveredFiles = []; previewProfiles = []; composeEdited = false
  els.composeFiles.value = ''
  els.composeProfiles.value = ''
  els.composeEnvFile.value = ''
  els.composeEnvFiles.replaceChildren()
  els.composeProfileMode.value = 'auto'
  previewRuntime = null
  els.composeDiscovered.replaceChildren()
  els.composeProfileChoices.replaceChildren()
  els.composeDiscoveryStatus.textContent = ''
  els.composeProfileStatus.textContent = ''
  els.composeRescan.disabled = !path
  els.composeApply.disabled = !path
  renderWorkspaces()
  renderServices()
  renderLog(true)
  if (path) { void loadComposeOptions(); void loadDiscoveredFiles(); void loadOperations(); void loadEvents(); void loadViews() }
  void loadServices()
}

async function loadOperations(force = false): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = operationRequests.begin(force)
  if (!ticket) return
  try {
    const { operations } = await orca.plugin.request('operations.list', { path }, { signal: ticket.signal })
    if (!operationRequests.current(ticket)) return
    const changed = JSON.stringify(operations) !== JSON.stringify(state.operations)
    if (operations.some((op) => op.status === 'running' && !state.operations.some((old) => old.id === op.id))) els.operations.open = true
    state.operations = operations
    const active = operations.find((operation) => operation.status === 'running')
    els.operations.hidden = operations.length === 0
    els.operationsTitle.textContent = active ? `Operations · ${active.title} · running` : 'Recent operations'
    renderOperations(els.operationsList, operations, (id) => {
      void orca.plugin.request('operations.open', { path, id }).catch((error) => { if (state.path === path) setNotice(errorText(error), true) })
    })
    if (changed) renderServices()
  } catch (error) {
    if (operationRequests.current(ticket)) {
      els.operations.hidden = false
      els.operationsTitle.textContent = `Operations unavailable: ${errorText(error)}`
    }
  } finally { operationRequests.finish(ticket) }
}

function renderEvents(): void {
  const history = state.events
  els.events.hidden = !state.path
  els.eventsTitle.textContent = !history ? 'Container events · loading…' : `Container events · ${history.connected ? 'watching' : 'disconnected'}${history.limited ? ' · older events omitted' : ''}`
  const services = showingAll() ? null : state.key === GROUP ? state.selectedServices : state.service ? [state.service] : null
  const events = history?.events.filter((event) => !services || services.includes(event.service)) ?? []
  const entries = events.map((event) => ({ key: event.id, create: () => {
    const row = el('div', 'event')
    const button = el('button', 'link', `${event.t.slice(0, 10)} ${formatTime(event.t)} ${event.name} · ${event.action}${event.detail ? ` · ${event.detail}` : ''}`)
    button.title = 'Show logs 30 seconds before and after this event'
    button.addEventListener('click', () => jumpToEvent(event))
    row.append(button)
    return row
  } }))
  if (history?.error) entries.unshift({ key: history.error, create: () => el('div', 'hint', history.error!) })
  if (!events.length) entries.push({ key: 'empty', create: () => el('div', 'hint', 'No observed events for these services. History is recorded while this project is watched.') })
  reconcileLog(els.eventsList, entries)
}

async function loadEvents(): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = eventRequests.begin()
  if (!ticket) return
  try {
    const history = await orca.plugin.request('events.list', { path }, { signal: ticket.signal })
    if (!eventRequests.current(ticket)) return
    state.events = history
    renderEvents()
  } catch (error) {
    if (eventRequests.current(ticket)) { els.eventsTitle.textContent = `Container events unavailable: ${errorText(error)}` }
  } finally { eventRequests.finish(ticket) }
}

function jumpToEvent(event: ContainerEvent): void {
  const row = state.rows.find((row) => row.containerId === event.containerId)
  if (!row) { setNotice('This container was removed. Its event history is retained, but Docker no longer has its logs.'); return }
  // Set the selection directly so no unbounded log request races the event window.
  state.key = row.key; state.service = row.service; state.selectedServices = null
  eventRange = { since: new Date(Date.parse(event.t) - 30_000).toISOString(), until: new Date(Date.parse(event.t) + 30_000).toISOString() }
  els.window.value = 'event'
  els.follow.checked = false
  resetLogs(); renderServices(); renderEvents(); renderLog()
  void loadLogs(true)
}

els.live.addEventListener('click', () => {
  eventRange = null; els.window.value = 'tail'; els.follow.checked = true
  resetLogs(); renderLog(true); savePrefs(); void loadLogs(true)
})

function renderViews(): void {
  const selected = els.savedView.value
  const placeholder = el('option', undefined, viewsLoaded ? 'Saved views…' : 'Loading views…')
  placeholder.value = ''
  const options = views.map((view) => { const option = el('option', undefined, view.name); option.value = view.id; return option })
  els.savedView.replaceChildren(placeholder, ...options)
  els.savedView.value = views.some((view) => view.id === selected) ? selected : ''
  els.savedView.disabled = !viewsLoaded || viewsSaving
  els.viewSave.disabled = !state.path || !viewsLoaded || viewsSaving || !els.viewName.value.trim()
  els.viewDelete.disabled = !els.savedView.value || viewsSaving
}
async function loadViews(): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = viewRequests.begin(true)!
  try {
    const answer = await orca.plugin.request('views.get', { path }, { signal: ticket.signal })
    if (!viewRequests.current(ticket)) return
    views = answer.views; viewsLoaded = true; renderViews()
  } catch (error) {
    if (viewRequests.current(ticket)) setNotice(`Could not load saved views: ${errorText(error)}`, true)
  } finally { viewRequests.finish(ticket) }
}
async function storeViews(remove = false): Promise<void> {
  const path = state.path
  if (!path || !viewsLoaded || viewsSaving) return
  const id = els.savedView.value || `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const view: SavedView = { id, name: els.viewName.value.trim(), services: showingAll() ? null : state.key === GROUP ? [...state.selectedServices ?? []] : state.service ? [state.service] : [],
    filter: els.filter.value, search: els.search.value, level: els.level.value as SavedView['level'], window: (els.window.value === 'event' ? 'tail' : els.window.value) as SavedView['window'],
    group: els.group.checked, json: els.json.checked, wrap: els.wrap.checked, timestamps: els.timestamps.checked }
  const next = remove ? views.filter((view) => view.id !== id) : views.some((view) => view.id === id) ? views.map((item) => item.id === id ? view : item) : [...views, view]
  const ticket = viewRequests.begin(true)!
  viewsSaving = true; renderViews()
  try {
    const answer = await orca.plugin.request('views.set', { path, views: next }, { signal: ticket.signal })
    if (!viewRequests.current(ticket)) return
    views = answer.views; viewsSaving = false; renderViews()
    els.savedView.value = remove ? '' : id
    if (remove) els.viewName.value = ''
    renderViews()
    setNotice(remove ? 'Saved view deleted.' : 'View saved for this project.')
  } catch (error) {
    if (viewRequests.current(ticket)) setNotice(`Could not save view: ${errorText(error)}`, true)
  } finally { if (viewRequests.current(ticket)) { viewsSaving = false; renderViews() }; viewRequests.finish(ticket) }
}
els.viewName.addEventListener('input', renderViews)
els.viewSave.addEventListener('click', () => void storeViews())
els.viewDelete.addEventListener('click', () => void storeViews(true))
els.savedView.addEventListener('change', () => {
  const view = views.find((view) => view.id === els.savedView.value)
  els.viewName.value = view?.name ?? ''
  renderViews()
  if (!view) return
  eventRange = null
  els.filter.value = view.filter; els.search.value = view.search; els.level.value = view.level; els.window.value = view.window
  els.group.checked = view.group; els.json.checked = view.json; els.wrap.checked = view.wrap; els.timestamps.checked = view.timestamps
  selectKey(view.services === null ? ALL : GROUP, null, view.services, false)
  resetLogs(); renderLog(true); void loadLogs(true)
})

const composeFiles = () => [...new Set(els.composeFiles.value.split('\n').map((file) => file.trim()).filter(Boolean))]
const composeProfiles = () => [...new Set(els.composeProfiles.value.split(',').map((profile) => profile.trim()).filter(Boolean))]

function renderComposeFiles(): void {
  const selected = composeFiles()
  const files = [...new Set([...selected, ...discoveredFiles])]
  els.composeDiscovered.replaceChildren(...files.map((file) => {
    const label = el('label', 'compose-choice')
    const check = el('input')
    check.type = 'checkbox'; check.checked = selected.includes(file)
    check.setAttribute('aria-label', `Use Compose config ${file}`)
    check.addEventListener('change', () => {
      const current = composeFiles()
      els.composeFiles.value = (check.checked ? [...current, file] : current.filter((item) => item !== file)).join('\n')
      editComposeFiles()
    })
    const index = selected.indexOf(file)
    label.append(check, el('span', undefined, `${index >= 0 ? `${index + 1}. ` : ''}${file}`))
    return label
  }))
}

function runtimeText(runtime: ComposeRuntime, running = false): string {
  const names = (values: string[]) => values.length ? values.join(', ') : 'none'
  const text = [
    `Environment: ${runtime.envFile ?? 'automatic Compose .env discovery'}`,
    `Environment profiles: ${names(runtime.environmentProfiles)}`,
    `Effective profiles (${runtime.profileSource}): ${names(runtime.effectiveProfiles)}`,
    `Enabled services: ${names(runtime.enabledServices)}`
  ]
  if (running) {
    return [`Project command profiles (${runtime.profileSource}): ${names(runtime.effectiveProfiles)}`, `Running services: ${names(runtime.runningServices)}`, ...(runtime.outsideSelection.length ? [`Running outside selection: ${names(runtime.outsideSelection)}`] : [])].join('\n')
  }
  return text.join('\n')
}

function composeDraft(): ComposeOptions {
  const manual = els.composeProfileMode.value === 'manual'
  const profiles = manual ? composeProfiles() : []
  return { files: composeFiles(), profiles, ...(els.composeEnvFile.value.trim() ? { envFile: els.composeEnvFile.value.trim() } : {}),
    ...(manual && !profiles.length ? { profileMode: 'manual' as const } : {}) }
}

function renderComposeProfiles(): void {
  const selected = els.composeProfileMode.value === 'auto' ? previewRuntime?.effectiveProfiles.includes('*') ? previewProfiles : previewRuntime?.effectiveProfiles ?? [] : composeProfiles()
  els.composeProfileChoices.replaceChildren(...[...new Set([...previewProfiles, ...selected])].map((profile) => {
    const label = el('label', 'compose-choice')
    const check = el('input')
    check.type = 'checkbox'; check.checked = selected.includes(profile)
    check.setAttribute('aria-label', `Enable Compose profile ${profile}`)
    check.addEventListener('change', () => {
      const current = [...selected]
      els.composeProfileMode.value = 'manual'
      els.composeProfiles.value = (check.checked ? [...current, profile] : current.filter((item) => item !== profile)).join(', ')
      composeEdited = true
      renderComposeProfiles()
      void loadComposeProfiles()
    })
    label.append(check, el('span', undefined, profile + (!previewProfiles.includes(profile) ? ' (not in selected configs)' : '')))
    return label
  }))
}

async function loadDiscoveredFiles(): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = discoveryRequests.begin(true)!
  els.composeDiscoveryStatus.textContent = 'Scanning project folders…'
  els.composeRescan.disabled = true
  try {
    const answer = await orca.plugin.request('compose.discover', { path }, { signal: ticket.signal })
    if (!discoveryRequests.current(ticket)) return
    discoveredFiles = answer.files
    els.composeEnvFiles.replaceChildren(...(answer.envFiles ?? []).map((file) => { const option = el('option'); option.value = file; return option }))
    renderComposeFiles()
    els.composeDiscoveryStatus.textContent = answer.truncated ? 'Scan limit reached. Additional paths can be entered below.' : answer.files.length ? `${answer.files.length} config${answer.files.length === 1 ? '' : 's'} found` : 'No Compose configs found. You can enter a path below.'
  } catch (error) {
    if (discoveryRequests.current(ticket)) els.composeDiscoveryStatus.textContent = `Could not scan folders: ${errorText(error)}`
  } finally { if (discoveryRequests.current(ticket)) els.composeRescan.disabled = false; discoveryRequests.finish(ticket) }
}

async function loadComposeProfiles(): Promise<void> {
  const path = state.path
  if (!path) return
  const files = composeFiles()
  const ticket = profileRequests.begin(true)!
  previewProfiles = []; previewRuntime = null; renderComposeProfiles()
  els.composeProfileStatus.textContent = 'Reading profiles…'
  try {
    const draft = composeDraft()
    const answer = await orca.plugin.request('compose.profiles', { path, ...draft }, { signal: ticket.signal })
    if (!profileRequests.current(ticket) || JSON.stringify(files) !== JSON.stringify(composeFiles())) return
    previewProfiles = answer.profiles
    previewRuntime = answer.runtime ?? null
    renderComposeProfiles()
    els.composeProfileStatus.style.whiteSpace = 'pre-wrap'
    els.composeProfileStatus.textContent = answer.runtime ? runtimeText(answer.runtime) : answer.profiles.length ? 'Choose profiles, then Apply.' : 'No optional profiles in these configs.'
  } catch (error) {
    if (profileRequests.current(ticket)) els.composeProfileStatus.textContent = `Could not read profiles: ${errorText(error)}`
  } finally { profileRequests.finish(ticket) }
}

function editComposeFiles(): void {
  composeEdited = true
  renderComposeFiles()
  void loadComposeProfiles()
}

async function loadComposeOptions(): Promise<void> {
  const path = state.path
  if (!path) return
  const ticket = configRequests.begin(true)!
  try {
    const { options } = await orca.plugin.request('compose.get', { path }, { signal: ticket.signal })
    if (!configRequests.current(ticket)) return
    state.options = options
    // Discovery and manual editing can finish before saved settings arrive.
    if (!composeEdited) {
      els.composeFiles.value = options.files.join('\n')
      els.composeProfiles.value = options.profiles.join(', ')
      els.composeEnvFile.value = options.envFile ?? ''
      els.composeProfileMode.value = options.profileMode ?? (options.profiles.length ? 'manual' : 'auto')
      renderComposeFiles()
      void loadComposeProfiles()
    }
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
  const options = composeDraft()
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
  if (state.key === ALL || state.key === GROUP) return { key: state.key, service: null }
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
    state.runtime = answer.runtime ?? null
    if (answer.runtime) els.composeRuntime.textContent = runtimeText(answer.runtime, true)
    if (answer.runtime && !composeEdited && JSON.stringify(composeDraft()) === JSON.stringify(answer.options)) {
      profileRequests.invalidate()
      previewRuntime = answer.runtime
      previewProfiles = answer.profiles
      renderComposeProfiles()
      els.composeProfileStatus.style.whiteSpace = 'pre-wrap'
      els.composeProfileStatus.textContent = runtimeText(answer.runtime)
    }
    state.rows = answer.rows
    state.dockerContext = answer.context
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

function selectKey(key: string, service: string | null, services: string[] | null = null, fetch = true): void {
  const same = key === state.key && JSON.stringify(services) === JSON.stringify(state.selectedServices)
  eventRange = null
  if (els.window.value === 'event') els.window.value = 'tail'
  state.selectedServices = services
  state.key = key
  state.service = service
  if (state.path) lastSelection.set(state.path, { key, service, services })
  renderServices()
  renderEvents()
  if (same) return
  resetLogs()
  renderLog(true)
  if (fetch) void loadLogs(true)
}

/** Where a container's log starts for the chosen period. */
function sinceFor(row: ServiceRow): string | undefined {
  if (eventRange) return eventRange.since
  const window = els.window.value
  if (window === 'start') return row.startedAt ?? undefined
  const span = WINDOWS[window]
  return span ? new Date(Date.now() - span).toISOString() : undefined
}

function logTargets(): LogTarget[] {
  const rows = selectedRows().filter((r) => r.containerId)
  return rows.map((r) => {
    const since = sinceFor(r)
    return { service: r.service, containerId: r.containerId as string, name: r.name, ...(since ? { since } : {}), ...(eventRange ? { until: eventRange.until } : {}) }
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
  await loadOperations(true)
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
  await loadOperations(true)
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
  if (state.key === GROUP) return `services "${state.selectedServices?.join(', ')}" of the compose project "${state.project}"`
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
  const name = showingAll() || state.key === GROUP ? state.project || 'compose' : selectedRow()?.name ?? 'container'
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
      if (typeof value === 'string' && [...select.options].some((o) => o.value === value && !o.disabled)) select.value = value
    }
  } catch {
    // Defaults from the markup stay.
  }
}

function savePrefs(): void {
  const prefs = {
    servicesHeight,
    ...Object.fromEntries(Object.entries(checkboxes).map(([name, input]) => [name, input.checked])),
    ...Object.fromEntries(Object.entries(selects).map(([name, select]) => [name, select.value === 'event' ? 'tail' : select.value]))
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

function renderSearchCount(): void {
  const count = searchNavigation.count
  els.searchCount.textContent = els.search.value ? `${count ? searchNavigation.index + 1 : 0} / ${count}${searchLimited ? '+' : ''}` : ''
  els.searchCount.title = searchLimited ? 'First 1000 matches in the loaded log' : 'Matches in the loaded log'
  els.searchPrevious.disabled = els.searchNext.disabled = count === 0
  const errors = els.log.querySelectorAll(':scope > .lvl-error').length
  els.errorPrevious.disabled = els.errorNext.disabled = errors === 0
}
function moveSearch(delta: number): void { searchNavigation.move(delta); renderSearchCount() }
function moveError(delta: number): void {
  const errors = [...els.log.querySelectorAll<HTMLElement>(':scope > .lvl-error')]
  if (!errors.length) return
  const current = errors.indexOf(lastErrorNode!)
  const index = current < 0 ? delta > 0 ? 0 : errors.length - 1 : (current + delta + errors.length) % errors.length
  lastErrorNode?.classList.remove('current-error')
  lastErrorNode = errors[index]
  lastErrorNode.classList.add('current-error')
  revealLogNode(lastErrorNode)
}
els.search.addEventListener('input', () => renderLog())
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1) }
  if (event.key === 'Escape') { els.search.value = ''; renderLog(); els.log.focus() }
})
els.searchPrevious.addEventListener('click', () => moveSearch(-1))
els.searchNext.addEventListener('click', () => moveSearch(1))
els.errorPrevious.addEventListener('click', () => moveError(-1))
els.errorNext.addEventListener('click', () => moveError(1))
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); els.search.focus(); els.search.select() }
  if (event.key === 'F3') { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1) }
  const editing = (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]')
  if (!editing && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); moveError(event.key === 'ArrowDown' ? 1 : -1) }
})

// ---------- wiring ----------

els.refresh.append(icon('restart'))
els.save.append(icon('save'))
els.clear.append(icon('clear'))
els.copy.addEventListener('click', copyLog)
els.composeForm.addEventListener('submit', (event) => void applyCompose(event))
els.composeRescan.addEventListener('click', () => void loadDiscoveredFiles())
els.composeFiles.addEventListener('input', () => { composeEdited = true; profileRequests.invalidate(); renderComposeFiles(); els.composeProfileStatus.textContent = 'Finish editing to read profiles.' })
els.composeFiles.addEventListener('change', editComposeFiles)
els.composeProfiles.addEventListener('input', () => { composeEdited = true; els.composeProfileMode.value = 'manual'; profileRequests.invalidate(); renderComposeProfiles() })
els.composeProfiles.addEventListener('change', () => void loadComposeProfiles())
els.composeEnvFile.addEventListener('input', () => { composeEdited = true; profileRequests.invalidate(); previewRuntime = null; renderComposeProfiles(); els.composeProfileStatus.textContent = 'Finish editing to read profiles.' })
els.composeEnvFile.addEventListener('change', editComposeFiles)
els.composeProfileMode.addEventListener('change', () => { composeEdited = true; if (els.composeProfileMode.value === 'auto') els.composeProfiles.value = ''; renderComposeProfiles(); void loadComposeProfiles() })
$('compose-defaults').addEventListener('click', () => { els.composeFiles.value = ''; els.composeProfiles.value = ''; els.composeEnvFile.value = ''; els.composeProfileMode.value = 'auto'; els.composeForm.requestSubmit() })
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
  eventRange = null
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
setInterval(() => { if (!document.hidden) void loadOperations() }, 2000)
setInterval(() => {
  if (document.hidden) return
  void loadServices()
  void loadStats()
  void loadEvents()
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
