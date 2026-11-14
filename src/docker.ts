// Running the docker CLI and parsing what it prints. No Orca API here, so tests can use it directly.
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { ContainerStats, LogLine, ServiceRow } from './protocol'
import { createLimiter } from './async'
import { timeKey } from './log-time'

const limited = createLimiter(4)

/** An Error carrying a `code`, which Orca hands to the panel's `plugin.request` rejection. */
export function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Orca starts plugin workers with the app's PATH, which on macOS is often just /usr/bin:/bin when
 * Orca was opened from the Dock. Docker usually lives in one of these instead.
 */
function extraBinDirs(): string[] {
  if (process.platform === 'win32') return []
  const home = homedir()
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    join(home, '.docker', 'bin'),
    join(home, '.orbstack', 'bin'),
    join(home, '.rd', 'bin'),
    '/usr/bin'
  ]
}

function searchPath(): string[] {
  const fromEnv = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...fromEnv, ...extraBinDirs()])]
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The docker binary: the configured path, else the first `docker` on PATH or a usual location. */
export async function findDocker(configured: string): Promise<string> {
  const custom = configured.trim()
  if (custom) {
    if (isAbsolute(custom) && (await isExecutable(custom))) return custom
    throw fail('unavailable', `Docker path from settings is not an executable file: ${custom}`)
  }
  const name = process.platform === 'win32' ? 'docker.exe' : 'docker'
  for (const dir of searchPath()) {
    const candidate = join(dir, name)
    if (await isExecutable(candidate)) return candidate
  }
  throw fail('unavailable', 'Docker CLI not found. Set its path in Settings → Plugins → Docker Logs.')
}

/** Lets docker find its credential helpers and the other tools it shells out to. */
function childEnv(binary: string): NodeJS.ProcessEnv {
  const dirs = isAbsolute(binary) ? [dirname(binary), ...searchPath()] : searchPath()
  return { ...process.env, PATH: [...new Set(dirs)].join(delimiter) }
}

export type RunOptions = { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string | undefined> }

/** Long-lived event subscriptions have a separate, explicitly bounded lifecycle. */
export function spawnDocker(binary: string, args: string[]) {
  return spawn(binary, args, { env: childEnv(binary), stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Runs a binary without a shell; rejects with `code: 'action_failed'` and its stderr. */
export function run(
  binary: string,
  args: string[],
  { cwd, timeoutMs, signal, env }: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  return limited(() => new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd, env: { ...childEnv(binary), ...env }, timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr })
        const err = error as NodeJS.ErrnoException & { killed?: boolean }
        if (err.code === 'ENOENT') return reject(fail('unavailable', `Cannot run ${binary}`))
        if (err.killed) return reject(fail('timeout', `${args.slice(0, 2).join(' ')} timed out`))
        reject(fail('action_failed', stderr.trim() || err.message))
      }
    )
  }), signal)
}

/** Non-empty trimmed lines, as `config --profiles` and `ps -q` print them. */
export function lines(stdout: string): string[] {
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** What the panel needs from `docker compose config --format json`. */
export type ComposeConfig = {
  name: string
  services: Record<string, { profiles: string[]; build: boolean; mounts: Mount[] }>
}

/** A bind mount: a folder of this machine (`source`) seen at `target` inside the container. */
export type Mount = { source: string; target: string }

export function parseConfig(stdout: string): ComposeConfig {
  type RawService = { profiles?: unknown; build?: unknown; volumes?: { type?: unknown; source?: unknown; target?: unknown }[] }
  const raw = JSON.parse(stdout) as { name?: unknown; services?: Record<string, RawService> }
  if (typeof raw.name !== 'string' || !raw.name) throw fail('action_failed', 'docker compose config printed no project name')
  const services: ComposeConfig['services'] = {}
  for (const [name, service] of Object.entries(raw.services ?? {})) {
    const profiles = Array.isArray(service.profiles) ? service.profiles.filter((p): p is string => typeof p === 'string') : []
    const mounts = (Array.isArray(service.volumes) ? service.volumes : []).flatMap((v) =>
      v.type === 'bind' && typeof v.source === 'string' && typeof v.target === 'string' ? [{ source: v.source, target: v.target }] : []
    )
    services[name] = { profiles, build: service.build !== undefined && service.build !== null, mounts }
  }
  return { name: raw.name, services }
}

/** One container from `docker inspect`, with what the rows show. */
export type Container = {
  id: string
  name: string
  service: string
  state: string
  exitCode: number | null
  oomKilled: boolean
  restartCount: number
  stateError: string
  project: string
  workingDir: string
  health: string
  healthLog: string
  startedAt: string | null
  finishedAt: string | null
  ports: number[]
  portBindings: ServiceRow['portBindings']
}

type InspectEntry = {
  Id?: unknown
  Name?: unknown
  RestartCount?: unknown
  State?: {
    Status?: unknown
    ExitCode?: unknown
    OOMKilled?: unknown
    Error?: unknown
    StartedAt?: unknown
    FinishedAt?: unknown
    Health?: { Status?: unknown; Log?: { Output?: unknown }[] }
  }
  Config?: { Labels?: Record<string, unknown> }
  NetworkSettings?: { Ports?: Record<string, { HostPort?: unknown; HostIp?: unknown }[] | null> }
}

/** Docker's "never" timestamp (`0001-01-01T00:00:00Z`) and missing values become null. */
function time(value: unknown): string | null {
  return typeof value === 'string' && !value.startsWith('0001-') ? value : null
}

/** Published TCP host ports, once each (Docker lists IPv4 and IPv6 bindings separately). */
function publishedPorts(ports: InspectEntry['NetworkSettings']): ServiceRow['portBindings'] {
  const found = new Map<string, ServiceRow['portBindings'][number]>()
  for (const [key, bindings] of Object.entries(ports?.Ports ?? {})) {
    if (!key.endsWith('/tcp')) continue
    for (const binding of bindings ?? []) {
      const port = Number(binding.HostPort)
      const containerPort = Number(key.split('/')[0])
      const host = typeof binding.HostIp === 'string' ? binding.HostIp : ''
      if (Number.isInteger(port) && port > 0 && port <= 65535) found.set(`${host}:${port}`, { port, containerPort, host })
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

export function parseInspect(stdout: string): Container[] {
  const entries = JSON.parse(stdout) as InspectEntry[]
  return entries.flatMap((entry): Container[] => {
    const service = entry.Config?.Labels?.['com.docker.compose.service']
    if (typeof entry.Id !== 'string' || typeof service !== 'string') return []
    const state = entry.State ?? {}
    // Docker keeps the last health status after a container stops; it only means something while it runs.
    const health = state.Status === 'running' && typeof state.Health?.Status === 'string' ? state.Health.Status : ''
    const lastCheck = state.Health?.Log?.at(-1)?.Output
    const labels = entry.Config?.Labels ?? {}
    const portBindings = publishedPorts(entry.NetworkSettings)
    return [
      {
        id: entry.Id,
        name: String(entry.Name ?? '').replace(/^\//, ''),
        service,
        state: typeof state.Status === 'string' ? state.Status : 'unknown',
        exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
        oomKilled: state.OOMKilled === true,
        restartCount: typeof entry.RestartCount === 'number' ? entry.RestartCount : 0,
        stateError: typeof state.Error === 'string' ? state.Error.slice(0, 2000) : '',
        project: typeof labels['com.docker.compose.project'] === 'string' ? labels['com.docker.compose.project'] as string : '',
        workingDir: typeof labels['com.docker.compose.project.working_dir'] === 'string' ? labels['com.docker.compose.project.working_dir'] as string : '',
        health,
        healthLog: health && health !== 'healthy' && typeof lastCheck === 'string' ? lastCheck.trim().slice(0, 1000) : '',
        startedAt: time(state.StartedAt),
        finishedAt: time(state.FinishedAt),
        ports: [...new Set(portBindings.map((p) => p.port))],
        portBindings
      }
    ]
  })
}

/** Services of the compose file, each followed by its containers; a service without one gets a placeholder row. */
export function buildRows(config: ComposeConfig, containers: Container[]): ServiceRow[] {
  const byService = new Map<string, Container[]>()
  for (const c of containers) byService.set(c.service, [...(byService.get(c.service) ?? []), c])
  const declared = Object.keys(config.services)
  // Containers of services the file no longer declares (orphans) go last.
  const names = [...declared, ...[...byService.keys()].filter((s) => !declared.includes(s))]
  return names.flatMap((service): ServiceRow[] => {
    const { profiles, build } = config.services[service] ?? { profiles: [], build: false, mounts: [] }
    const own = (byService.get(service) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    if (own.length === 0) {
      return [
        {
          key: `service:${service}`,
          service,
          containerId: null,
          name: service,
          state: 'not created',
          exitCode: null,
          oomKilled: false,
          restartCount: 0,
          stateError: '',
          health: '',
          healthLog: '',
          startedAt: null,
          finishedAt: null,
          ports: [],
          portBindings: [],
          profiles,
          build
        }
      ]
    }
    return own.map((c) => ({
      key: c.id,
      service,
      containerId: c.id,
      name: c.name,
      state: c.state,
      exitCode: c.exitCode,
      oomKilled: c.oomKilled,
      restartCount: c.restartCount,
      stateError: c.stateError,
      health: c.health,
      healthLog: c.healthLog,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      ports: c.ports,
      portBindings: c.portBindings,
      profiles,
      build
    }))
  })
}

/** `docker stats --no-stream --no-trunc --format '{{json .}}'`: one object per line. */
export function parseStats(stdout: string): Record<string, ContainerStats> {
  const stats: Record<string, ContainerStats> = {}
  for (const line of lines(stdout)) {
    const entry = JSON.parse(line) as { ID?: unknown; CPUPerc?: unknown; MemUsage?: unknown; MemPerc?: unknown }
    if (typeof entry.ID !== 'string') continue
    const [mem = '', memLimit = ''] = String(entry.MemUsage ?? '').split(' / ')
    stats[entry.ID] = { cpu: String(entry.CPUPerc ?? ''), mem, memLimit, memPercent: String(entry.MemPerc ?? '') }
  }
  return stats
}

const TIMESTAMPED = /^(\d{4}-\d\d-\d\dT\S+) ?(.*)$/s

function parseStream(text: string, fromStderr: boolean, src?: string): LogLine[] {
  const raw = text.split('\n')
  if (raw.at(-1) === '') raw.pop()
  let last = ''
  return raw.map((line) => {
    const match = TIMESTAMPED.exec(line)
    if (match) last = match[1]
    // A line without a timestamp (should not happen with --timestamps) sorts with the one before it.
    const parsed: LogLine = match ? { t: match[1], e: fromStderr, m: match[2] } : { t: last, e: fromStderr, m: line }
    return src === undefined ? parsed : { ...parsed, src }
  })
}

/** One container's `docker logs --timestamps` output: its stdout and stderr, each line tagged. */
export function containerLines(stdout: string, stderr: string, src?: string): LogLine[] {
  return [...parseStream(stdout, false, src), ...parseStream(stderr, true, src)]
}

/**
 * Lines of one or more containers in time order. Docker's timestamps are fixed width, so a
 * stable string sort interleaves them correctly.
 */
export function byTime(lines: LogLine[]): LogLine[] {
  return [...lines].sort((a, b) => timeKey(a.t).localeCompare(timeKey(b.t)))
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1

/**
 * Keeps the newest lines whose JSON fits in `maxBytes`, so the answer stays under Orca's 1 MiB
 * limit (escape codes and non-ASCII text grow when encoded, hence measuring the JSON).
 */
export function newestWithin(lines: LogLine[], maxBytes: number): { lines: LogLine[]; truncated: boolean } {
  let total = 0
  let start = lines.length
  while (start > 0) {
    const size = jsonBytes(lines[start - 1])
    if (total + size > maxBytes) break
    total += size
    start--
  }
  if (start === lines.length && lines.length > 0) {
    // The newest line alone is over the budget: keep its tail.
    const line = lines[lines.length - 1]
    return { lines: [{ ...line, m: line.m.slice(-Math.floor(maxBytes / 8)) }], truncated: true }
  }
  return { lines: lines.slice(start), truncated: start > 0 }
}

/** Quotes one argument for a POSIX shell, for commands typed into an Orca terminal. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}
