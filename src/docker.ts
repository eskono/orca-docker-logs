// Running the docker CLI and parsing what it prints. No Orca API here, so tests can use it directly.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { ContainerStats, LogLine, ServiceRow } from './protocol'

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

export type RunOptions = { cwd?: string; timeoutMs: number }

/** Runs a binary without a shell; rejects with `code: 'action_failed'` and its stderr. */
export function run(
  binary: string,
  args: string[],
  { cwd, timeoutMs }: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd, env: childEnv(binary), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr })
        const err = error as NodeJS.ErrnoException & { killed?: boolean }
        if (err.code === 'ENOENT') return reject(fail('unavailable', `Cannot run ${binary}`))
        if (err.killed) return reject(fail('timeout', `${args.slice(0, 2).join(' ')} timed out`))
        reject(fail('action_failed', stderr.trim() || err.message))
      }
    )
  })
}

type PsEntry = {
  ID: string
  Name: string
  Service: string
  State: string
  Status: string
  Health?: string
}

/** `docker compose ps --format json`: a JSON array before Compose 2.21, one object per line after. */
export function parsePs(stdout: string): PsEntry[] {
  const text = stdout.trim()
  if (!text) return []
  const values: unknown[] = text.startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
  return values.filter(
    (v): v is PsEntry =>
      typeof v === 'object' && v !== null && typeof (v as PsEntry).ID === 'string' && typeof (v as PsEntry).Service === 'string'
  )
}

/** `docker compose config --services`: one name per line. */
export function parseServices(stdout: string): string[] {
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** Services in compose order, each followed by its containers; a service without one gets a placeholder row. */
export function buildRows(services: string[], containers: PsEntry[]): ServiceRow[] {
  const byService = new Map<string, PsEntry[]>()
  for (const c of containers) byService.set(c.Service, [...(byService.get(c.Service) ?? []), c])
  // Containers of services the config no longer lists (orphans, inactive profiles) go last.
  const names = [...services, ...[...byService.keys()].filter((s) => !services.includes(s))]
  return names.flatMap((service): ServiceRow[] => {
    const own = (byService.get(service) ?? []).sort((a, b) => a.Name.localeCompare(b.Name))
    if (own.length === 0) {
      return [{ key: `service:${service}`, service, containerId: null, name: service, state: 'not created', status: 'Not created', health: '' }]
    }
    return own.map((c) => ({
      key: c.ID,
      service,
      containerId: c.ID,
      name: c.Name,
      state: c.State,
      status: c.Status,
      health: c.Health ?? ''
    }))
  })
}

/** `docker stats --no-stream --no-trunc --format '{{json .}}'`: one object per line. */
export function parseStats(stdout: string): Record<string, ContainerStats> {
  const stats: Record<string, ContainerStats> = {}
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line) as { ID?: unknown; CPUPerc?: unknown; MemUsage?: unknown; MemPerc?: unknown }
    if (typeof entry.ID !== 'string') continue
    const [mem = '', memLimit = ''] = String(entry.MemUsage ?? '').split(' / ')
    stats[entry.ID] = { cpu: String(entry.CPUPerc ?? ''), mem, memLimit, memPercent: String(entry.MemPerc ?? '') }
  }
  return stats
}

const TIMESTAMPED =/^(\d{4}-\d\d-\d\dT\S+) ?(.*)$/s

function parseStream(text: string, fromStderr: boolean): LogLine[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let last = ''
  return lines.map((raw) => {
    const match = TIMESTAMPED.exec(raw)
    if (match) last = match[1]
    // A line without a timestamp (should not happen with --timestamps) sorts with the one before it.
    return match ? { t: match[1], e: fromStderr, m: match[2] } : { t: last, e: fromStderr, m: raw }
  })
}

/**
 * `docker logs --timestamps` writes the container's stdout and stderr to its own stdout and
 * stderr. Docker's timestamps are fixed width, so a stable string sort interleaves them in order.
 */
export function mergeLogs(stdout: string, stderr: string): LogLine[] {
  return [...parseStream(stdout, false), ...parseStream(stderr, true)].sort((a, b) =>
    a.t < b.t ? -1 : a.t > b.t ? 1 : 0
  )
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
