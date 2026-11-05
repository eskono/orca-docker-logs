// The plugin's worker: answers the panel by running the docker CLI in a workspace folder, and
// keeps a status bar item (and crash notifications) for the focused project.
import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildRows,
  byTime,
  containerLines,
  fail,
  findDocker,
  lines,
  newestWithin,
  parseConfig,
  parseInspect,
  parseStats,
  run,
  shellQuote,
  type ComposeConfig
} from './docker'
import type { FocusContext, ProjectAction, Requests, ServiceAction, ServiceRow, Workspace } from './protocol'
import { openFile, revealTerminal } from './orca-cli'
import { resolveSource } from './sources'
import { ProblemTracker, summarize } from './status'
import { hasComposeFile, localOnly, resolveFocused, type ListedWorkspace } from './workspaces'

/** Lines asked from each `docker logs`; the answer is then trimmed to fit `MAX_ANSWER_BYTES`. */
const TAIL_LINES = 1000
/** With a time window the window decides, up to this many lines per container. */
const TAIL_LINES_IN_WINDOW = 5000
const MAX_ANSWER_BYTES = 900 * 1024
const MAX_CONTAINERS = 200
const SERVICE_ACTIONS: readonly ServiceAction[] = ['start', 'stop', 'restart', 'build']
const PROJECT_ACTIONS: readonly ProjectAction[] = ['up', 'restart', 'down']
const CONTAINER_ID = /^[0-9a-f]{12,64}$/
/** Compose service names and Docker container names. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/
const WORKSPACES_TTL_MS = 10_000
const CONFIG_TTL_MS = 15_000
const STATUS_POLL_MS = 10_000
const STATUS_ITEM = 'containers'
const AGENT_MAX_LINES = 300
const AGENT_MAX_CHARS = 24_000
/** Stack trace paths: absolute, no parent segments or control characters. */
const TRACE_PATH = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0-\x1f]{1,1023}$/
const MAX_FILES = 200

let statusTimer: ReturnType<typeof setInterval> | null = null

export function deactivate(): void {
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = null
}

type Handler<K extends keyof Requests> = (input: Requests[K]['input']) => Promise<Requests[K]['output']>

/** Storage key of the "cleared at" mark for one service of one project. */
function clearedKey(path: string, service: string): string {
  return `cleared:${createHash('sha256').update(`${path}\0${service}`).digest('hex').slice(0, 32)}`
}

const latest = (...times: (string | null | undefined)[]): string | null =>
  times.reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null)

const profileArgs = (profiles: string[]) => profiles.flatMap((p) => ['--profile', p])

function invalid(message: string): Error {
  return fail('invalid_params', message)
}

function checkName(value: unknown, what: string): string {
  if (typeof value === 'string' && NAME.test(value)) return value
  throw invalid(`Invalid ${what}`)
}

function checkContainer(id: unknown): string {
  if (typeof id === 'string' && CONTAINER_ID.test(id)) return id
  throw invalid('Invalid container id')
}

function checkTracePath(value: unknown): string {
  if (typeof value === 'string' && TRACE_PATH.test(value)) return value
  throw invalid('Invalid file path')
}

function checkPosition(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10_000_000) return value
  throw invalid(`Invalid ${what}`)
}

function checkTime(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && TIMESTAMP.test(value)) return value
  throw invalid('Invalid time')
}

/** The newest lines that fit both limits, in a code fence no backtick run in them can close. */
function fencedTail(logLines: string[]): string {
  const kept: string[] = []
  let chars = 0
  for (let i = logLines.length - 1; i >= 0 && kept.length < AGENT_MAX_LINES; i--) {
    chars += logLines[i].length + 1
    if (chars > AGENT_MAX_CHARS) break
    kept.unshift(logLines[i])
  }
  const text = kept.join('\n')
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}text\n${text}\n${fence}`
}

export default function activate(orca: OrcaWorkerApi): void {
  let cachedWorkspaces: { at: number; list: Workspace[] } | null = null
  const configCache = new Map<string, { at: number; config: ComposeConfig; profiles: string[] }>()

  async function localWorkspaces(fresh = false): Promise<Workspace[]> {
    if (!fresh && cachedWorkspaces && Date.now() - cachedWorkspaces.at < WORKSPACES_TTL_MS) return cachedWorkspaces.list
    const answer = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
    cachedWorkspaces = { at: Date.now(), list: localOnly(answer.workspaces) }
    return cachedWorkspaces.list
  }

  /** The panel names folders by path; only act in a local Orca workspace. */
  async function workspaceFor(path: unknown): Promise<Workspace> {
    const workspace = typeof path === 'string' ? (await localWorkspaces()).find((w) => w.path === path) : undefined
    if (workspace) return workspace
    throw fail('not_permitted', 'Not a local Orca workspace')
  }

  async function docker(): Promise<string> {
    const configured = await orca.settings.get('dockerPath')
    return findDocker(typeof configured === 'string' ? configured : '')
  }

  /** The compose model with every profile enabled, so services of inactive profiles are listed too. */
  async function composeConfig(path: string, bin: string, fresh: boolean) {
    const cached = configCache.get(path)
    if (!fresh && cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached
    const profiles = lines((await run(bin, ['compose', 'config', '--profiles'], { cwd: path, timeoutMs: 20_000 })).stdout)
    const json = await run(bin, ['compose', ...profileArgs(profiles), 'config', '--format', 'json'], {
      cwd: path,
      timeoutMs: 20_000
    })
    const entry = { at: Date.now(), config: parseConfig(json.stdout), profiles }
    configCache.set(path, entry)
    return entry
  }

  async function listProject(path: string, fresh = false): Promise<{ project: string; rows: ServiceRow[] }> {
    const bin = await docker()
    const { config } = await composeConfig(path, bin, fresh)
    const read = async () => {
      const filter = `label=com.docker.compose.project=${config.name}`
      const ids = lines((await run(bin, ['ps', '-aq', '--no-trunc', '--filter', filter], { timeoutMs: 20_000 })).stdout)
      return ids.length ? parseInspect((await run(bin, ['inspect', ...ids], { timeoutMs: 20_000 })).stdout) : []
    }
    // A container removed between `ps` and `inspect` fails the inspect; a second try sees the new set.
    const containers = await read().catch(read)
    return { project: config.name, rows: buildRows(config, containers) }
  }

  /** Brings a terminal the plugin opened to the front; the terminal still works if this fails. */
  async function reveal(terminalId: string): Promise<void> {
    const problem = await revealTerminal(terminalId)
    if (problem) orca.log(`could not switch to terminal ${terminalId}: ${problem}`)
  }

  /**
   * Runs docker in a new Orca terminal of the workspace, for commands whose output is worth
   * watching, and switches to it (Orca opens it in the background).
   */
  async function openTerminal(path: string, title: string, args: string[]): Promise<string> {
    const workspace = await workspaceFor(path)
    const command = `cd ${shellQuote(workspace.path)} && ${[await docker(), ...args].map(shellQuote).join(' ')}`
    const { terminalId } = (await orca.host.call('terminal.create', { workspaceId: workspace.id, title, command })) as {
      terminalId: string
    }
    await reveal(terminalId)
    return terminalId
  }

  async function clearedMark(path: string, service: string): Promise<string | null> {
    const stored = await orca.storage.get(clearedKey(path, service))
    return typeof stored === 'string' ? stored : null
  }

  const handlers: { [K in keyof Requests]: Handler<K> } = {
    'workspaces.list': async ({ context }) => {
      const all = await localWorkspaces(true)
      const flags = await Promise.all(all.map((w) => hasComposeFile(w.path)))
      return { workspaces: all.filter((_, i) => flags[i]), focused: await resolveFocused(context, all) }
    },

    'services.list': async (input) => listProject((await workspaceFor(input.path)).path, input.fresh === true),

    'stats.get': async (input) => {
      await workspaceFor(input.path)
      const ids = Array.isArray(input.containerIds) ? input.containerIds.map(checkContainer) : []
      if (ids.length > MAX_CONTAINERS) throw invalid('Too many containers')
      if (ids.length === 0) return { stats: {} }
      // --no-stream samples twice about a second apart to work out CPU, so this takes a while.
      const args = ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...ids]
      return { stats: parseStats((await run(await docker(), args, { timeoutMs: 30_000 })).stdout) }
    },

    'logs.get': async (input) => {
      const { path } = await workspaceFor(input.path)
      const raw = Array.isArray(input.targets) ? input.targets : []
      if (raw.length === 0 || raw.length > MAX_CONTAINERS) throw invalid('Invalid containers')
      const targets = raw.map((t) => ({
        service: checkName(t.service, 'service name'),
        id: checkContainer(t.containerId),
        name: checkName(t.name, 'container name'),
        since: checkTime(t.since)
      }))
      const services = [...new Set(targets.map((t) => t.service))]
      const marks = new Map(await Promise.all(services.map(async (s) => [s, await clearedMark(path, s)] as const)))
      const bin = await docker()
      const several = targets.length > 1
      const perContainer = await Promise.all(
        targets.map(async (t) => {
          const since = latest(marks.get(t.service), t.since)
          const tail = t.since ? TAIL_LINES_IN_WINDOW : several ? Math.max(200, Math.ceil(TAIL_LINES / targets.length)) : TAIL_LINES
          const args = ['logs', '--timestamps', '--tail', String(tail), ...(since ? ['--since', since] : []), t.id]
          const { stdout, stderr } = await run(bin, args, { timeoutMs: 20_000 })
          return containerLines(stdout, stderr, several ? t.name : undefined)
        })
      )
      return { ...newestWithin(byTime(perContainer.flat()), MAX_ANSWER_BYTES), clearedAt: latest(...marks.values()) }
    },

    'logs.clear': async (input) => {
      const { path } = await workspaceFor(input.path)
      const services = (Array.isArray(input.services) ? input.services : []).map((s) => checkName(s, 'service name'))
      if (services.length === 0 || services.length > MAX_CONTAINERS) throw invalid('Invalid services')
      const clearedAt = input.reset ? null : new Date().toISOString()
      await Promise.all(
        services.map((s) => (clearedAt ? orca.storage.set(clearedKey(path, s), clearedAt) : orca.storage.delete(clearedKey(path, s))))
      )
      return { clearedAt }
    },

    'service.action': async (input) => {
      const { path } = await workspaceFor(input.path)
      const service = checkName(input.service, 'service name')
      const action = input.action
      if (!SERVICE_ACTIONS.includes(action)) throw invalid('Unknown action')
      const id = input.containerId === null ? null : checkContainer(input.containerId)
      const bin = await docker()
      if (action === 'build' || (action === 'start' && id === null)) {
        // Creating or rebuilding may pull and build for minutes: show it in a terminal.
        const profiles = (await composeConfig(path, bin, false)).config.services[service]?.profiles ?? []
        const args = ['compose', ...profileArgs(profiles), 'up', '-d', ...(action === 'build' ? ['--build'] : []), service]
        return { terminalId: await openTerminal(path, `${action === 'build' ? 'build' : 'up'} ${service}`, args) }
      }
      if (id === null) throw invalid('The service has no container')
      await run(bin, [action, id], { timeoutMs: 60_000 })
      return { terminalId: null }
    },

    'project.action': async (input) => {
      const { path } = await workspaceFor(input.path)
      const action = input.action
      if (!PROJECT_ACTIONS.includes(action)) throw invalid('Unknown action')
      if (action === 'up') return { terminalId: await openTerminal(path, 'compose up', ['compose', 'up', '-d']) }
      // Every profile, so containers of services outside the active profiles restart or go too.
      const bin = await docker()
      const { profiles } = await composeConfig(path, bin, false)
      await run(bin, ['compose', ...profileArgs(profiles), action], { cwd: path, timeoutMs: 115_000 })
      return { terminalId: null }
    },

    'container.shell': async (input) => {
      const id = checkContainer(input.containerId)
      const name = checkName(input.name, 'container name')
      const shell = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
      return { terminalId: await openTerminal(input.path, `shell ${name}`, ['exec', '-it', id, 'sh', '-c', shell]) }
    },

    'code.resolve': async (input) => {
      const { path } = await workspaceFor(input.path)
      const service = checkName(input.service, 'service name')
      const files = (Array.isArray(input.files) ? input.files : []).map(checkTracePath)
      if (files.length > MAX_FILES) throw invalid('Too many files')
      const mounts = (await composeConfig(path, await docker(), false)).config.services[service]?.mounts ?? []
      const found = await Promise.all(files.map((file) => resolveSource(path, mounts, file)))
      return { files: Object.fromEntries(files.map((file, i) => [file, found[i]])) }
    },

    'code.open': async (input) => {
      const { path } = await workspaceFor(input.path)
      const service = checkName(input.service, 'service name')
      const file = checkTracePath(input.file)
      const line = checkPosition(input.line, 'line')
      const column = input.column === undefined ? undefined : checkPosition(input.column, 'column')
      const mounts = (await composeConfig(path, await docker(), false)).config.services[service]?.mounts ?? []
      const relative = await resolveSource(path, mounts, file)
      if (!relative) throw fail('action_failed', `${file} is not a file of this project`)
      await openFile(path, relative, line, column)
      return { opened: relative }
    },

    'agent.ask': async (input) => {
      const workspace = await workspaceFor(input.path)
      const source = typeof input.source === 'string' ? input.source.replace(/\s+/g, ' ').slice(0, 200) : 'a container'
      const logLines = (Array.isArray(input.lines) ? input.lines : []).filter((l): l is string => typeof l === 'string')
      if (logLines.length === 0) throw invalid('No log lines to send')
      const setting = await orca.settings.get('agent')
      const agent = typeof setting === 'string' && setting.trim() ? setting.trim() : 'claude'
      const prompt = [
        `Below are recent log lines of ${source} from this project's Docker Compose setup.`,
        'Find the cause of the errors or warnings in them and propose a fix in this project.',
        '',
        fencedTail(logLines)
      ].join('\n')
      const { terminalId } = (await orca.host.call('agent.launch', { workspaceId: workspace.id, agent, prompt })) as {
        terminalId: string
      }
      await reveal(terminalId)
      return { terminalId, agent }
    }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    orca.panels.handle(name, (input: unknown) => (handler as (i: unknown) => Promise<unknown>)(input ?? {}))
  }

  // ---------- status bar and notifications for the focused project ----------

  let focusedPath: string | null = null
  let ticking = false
  const tracker = new ProblemTracker()

  const updateStatus = (fields: { text?: string; tone?: string; tooltip?: string; visible: boolean }) =>
    orca.host.call('statusBar.update', { id: STATUS_ITEM, ...fields }).catch(() => undefined)

  async function tick(): Promise<void> {
    const path = focusedPath
    if (!path) {
      await updateStatus({ visible: false })
      return
    }
    if (ticking) return
    ticking = true
    try {
      const { project, rows } = await listProject(path)
      if (path !== focusedPath) return
      await updateStatus({ ...summarize(project, rows), visible: true })
      const fresh = tracker.update(rows, Date.now())
      if (fresh.length && (await orca.settings.get('notify')) !== false) {
        for (const { row, problem } of fresh) {
          const body = row.healthLog ? { body: row.healthLog } : {}
          void orca.host.call('notifications.show', { title: `${project}: ${row.name} ${problem}`, ...body }).catch(() => undefined)
        }
      }
    } catch (error) {
      if (path === focusedPath) {
        const message = error instanceof Error ? error.message : String(error)
        await updateStatus({ text: 'off', tone: 'neutral', tooltip: `Docker: ${message}`, visible: true })
      }
    } finally {
      ticking = false
    }
  }

  async function follow(context: FocusContext): Promise<void> {
    try {
      const focused = await resolveFocused(context, await localWorkspaces(true))
      const path = focused && (await hasComposeFile(focused.path)) ? focused.path : null
      if (path !== focusedPath) {
        focusedPath = path
        tracker.reset()
      }
    } catch {
      focusedPath = null
    }
    await tick()
  }

  // Fires once with the current context as it subscribes, then on every focus change.
  orca.events.on('workspace.changed', ({ context }) => follow(context))
  deactivate()
  statusTimer = setInterval(() => void tick(), STATUS_POLL_MS)
}
