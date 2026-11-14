import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { run, type ComposeConfig, type Container } from './docker'
import { validateOptions } from './compose'
import type { DetectedStack } from './protocol'

const label = (name: string) => `{{json (.Label "com.docker.compose.${name}")}}`
export const STACK_FORMAT = `{"id":{{json .ID}},"state":{{json .State}},"project":${label('project')},"service":${label('service')},"workingDir":${label('project.working_dir')},"files":${label('project.config_files')},"envFile":${label('project.environment_file')}}`
type Metadata = { id: string; state: string; project: string; service: string; workingDir: string; files: string; envFile: string }
export function parseStackMetadata(stdout: string): Metadata[] {
  return stdout.split('\n').filter(Boolean).slice(0, 2000).flatMap((line) => {
    try {
      const value = JSON.parse(line)
      if (['id', 'state', 'project', 'service', 'workingDir', 'files', 'envFile'].some((key) => typeof value[key] !== 'string') ||
        !/^[a-f0-9]{12,64}$/.test(value.id) || !/^[a-z0-9][a-z0-9_-]{0,254}$/.test(value.project) || !value.service || !isAbsolute(value.workingDir)) return []
      return [value as Metadata]
    } catch { return [] }
  })
}

/** Match labels to workspace-contained config files; names alone never establish ownership. */
export async function matchStacks(path: string, records: Metadata[]): Promise<DetectedStack[]> {
  const root = await realpath(path)
  const grouped = new Map<string, { record: Metadata; ids: Set<string>; running: Set<string> }>()
  for (const record of records) {
    const directory = await realpath(record.workingDir).catch(() => null)
    if (!directory) continue
    const rel = relative(root, directory)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const key = JSON.stringify([record.project, directory, record.files, record.envFile])
    const group = grouped.get(key) ?? { record, ids: new Set<string>(), running: new Set<string>() }
    group.ids.add(record.id)
    if (['running', 'restarting', 'paused'].includes(record.state)) group.running.add(record.id)
    grouped.set(key, group)
  }
  const result: DetectedStack[] = []
  for (const [key, { record, ids, running }] of grouped) {
    try {
      const files = await Promise.all(record.files.split(',').filter(Boolean).map(async (file) => relative(root, await realpath(isAbsolute(file) ? file : resolve(record.workingDir, file)))))
      if (!files.length) continue
      const options = await validateOptions(root, { files, profiles: [] })
      let envFile: string | undefined
      if (record.envFile && !record.envFile.includes(',')) {
        const env = relative(root, await realpath(isAbsolute(record.envFile) ? record.envFile : resolve(record.workingDir, record.envFile)))
        envFile = (await validateOptions(root, { files: [], profiles: [], envFile: env })).envFile
      }
      result.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 24), project: record.project, files: options.files, ...(envFile ? { envFile } : {}), containers: ids.size, running: running.size })
    } catch { /* Missing files or paths outside this workspace cannot select a configuration. */ }
  }
  return result.sort((a, b) => b.running - a.running || a.project.localeCompare(b.project) || a.id.localeCompare(b.id)).slice(0, 50)
}

/** One shared metadata poll; only a selected workspace's container IDs are inspected later. */
export class RunningStacks {
  private cached: { key: string; at: number; records: Metadata[] } | null = null
  private pending: { key: string; promise: Promise<Metadata[]> } | null = null
  async list(path: string, binary: string, context: string, signal?: AbortSignal): Promise<DetectedStack[]> {
    const key = `${binary}\0${context}`
    let records: Metadata[]
    if (this.cached?.key === key && Date.now() - this.cached.at < 4000) records = this.cached.records
    else {
      if (this.pending?.key !== key) {
        const promise = run(binary, ['ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project', '--format', STACK_FORMAT], { timeoutMs: 20_000 })
          .then((result) => { const records = parseStackMetadata(result.stdout); this.cached = { key, at: Date.now(), records }; return records })
        this.pending = { key, promise }
        void promise.finally(() => { if (this.pending?.promise === promise) this.pending = null }).catch(() => undefined)
      }
      records = await this.pending!.promise
    }
    signal?.throwIfAborted()
    return matchStacks(path, records)
  }
}

export function profilesOfRunning(config: ComposeConfig, containers: Container[]): { name: string; services: string[] }[] {
  const profiles = new Map<string, Set<string>>()
  for (const container of containers) {
    if (!['running', 'restarting', 'paused'].includes(container.state)) continue
    for (const profile of config.services[container.service]?.profiles ?? []) {
      const services = profiles.get(profile) ?? new Set<string>()
      services.add(container.service); profiles.set(profile, services)
    }
  }
  return [...profiles].sort(([a], [b]) => a.localeCompare(b)).map(([name, services]) => ({ name, services: [...services].sort() }))
}
