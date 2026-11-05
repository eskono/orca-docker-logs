// The plugin's worker: answers panel requests by running the docker CLI in a workspace folder.
import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { buildRows, fail, findDocker, mergeLogs, newestWithin, parsePs, parseServices, run } from './docker'
import type { Requests, ServiceAction } from './protocol'
import { hasComposeFile, localOnly, resolveFocused, type ListedWorkspace } from './workspaces'

/** Lines asked from `docker logs`; the answer is then trimmed to fit `MAX_ANSWER_BYTES`. */
const TAIL_LINES = 1000
const MAX_ANSWER_BYTES = 900 * 1024
const ACTIONS: readonly ServiceAction[] = ['start', 'stop', 'restart']
const CONTAINER_ID = /^[0-9a-f]{12,64}$/
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const WORKSPACES_TTL_MS = 10_000

type Handler<K extends keyof Requests> = (input: Requests[K]['input']) => Promise<Requests[K]['output']>

/** Storage key of the "cleared at" mark for one service of one project. */
function clearedKey(path: string, service: string): string {
  return `cleared:${createHash('sha256').update(`${path}\0${service}`).digest('hex').slice(0, 32)}`
}

export default function activate(orca: OrcaWorkerApi): void {
  let cachedWorkspaces: { at: number; list: ReturnType<typeof localOnly> } | null = null

  async function localWorkspaces(fresh = false) {
    if (!fresh && cachedWorkspaces && Date.now() - cachedWorkspaces.at < WORKSPACES_TTL_MS) return cachedWorkspaces.list
    const answer = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
    cachedWorkspaces = { at: Date.now(), list: localOnly(answer.workspaces) }
    return cachedWorkspaces.list
  }

  /** The panel names folders by path; only run docker in a local Orca workspace. */
  async function checkPath(path: unknown): Promise<string> {
    if (typeof path === 'string' && (await localWorkspaces()).some((w) => w.path === path)) return path
    throw fail('not_permitted', 'Not a local Orca workspace')
  }

  function checkService(service: unknown): string {
    if (typeof service === 'string' && SERVICE_NAME.test(service)) return service
    throw fail('invalid_params', 'Invalid service name')
  }

  function checkContainer(id: unknown): string {
    if (typeof id === 'string' && CONTAINER_ID.test(id)) return id
    throw fail('invalid_params', 'Invalid container id')
  }

  async function docker(): Promise<string> {
    const configured = await orca.settings.get('dockerPath')
    return findDocker(typeof configured === 'string' ? configured : '')
  }

  const handlers: { [K in keyof Requests]: Handler<K> } = {
    'workspaces.list': async ({ context }) => {
      const all = await localWorkspaces(true)
      const flags = await Promise.all(all.map((w) => hasComposeFile(w.path)))
      return {
        workspaces: all.filter((_, i) => flags[i]),
        focused: await resolveFocused(context, all)
      }
    },

    'services.list': async (input) => {
      const path = await checkPath(input.path)
      const bin = await docker()
      const [config, ps] = await Promise.all([
        run(bin, ['compose', 'config', '--services'], { cwd: path, timeoutMs: 20_000 }),
        run(bin, ['compose', 'ps', '--all', '--format', 'json'], { cwd: path, timeoutMs: 20_000 })
      ])
      return { rows: buildRows(parseServices(config.stdout), parsePs(ps.stdout)) }
    },

    'logs.get': async (input) => {
      const path = await checkPath(input.path)
      const service = checkService(input.service)
      const id = checkContainer(input.containerId)
      const stored = await orca.storage.get(clearedKey(path, service))
      const clearedAt = typeof stored === 'string' ? stored : null
      const args = ['logs', '--timestamps', '--tail', String(TAIL_LINES)]
      if (clearedAt) args.push('--since', clearedAt)
      const { stdout, stderr } = await run(await docker(), [...args, id], { timeoutMs: 20_000 })
      return { ...newestWithin(mergeLogs(stdout, stderr), MAX_ANSWER_BYTES), clearedAt }
    },

    'logs.clear': async (input) => {
      const key = clearedKey(await checkPath(input.path), checkService(input.service))
      if (input.reset) {
        await orca.storage.delete(key)
        return { clearedAt: null }
      }
      const clearedAt = new Date().toISOString()
      await orca.storage.set(key, clearedAt)
      return { clearedAt }
    },

    'service.action': async (input) => {
      const path = await checkPath(input.path)
      const service = checkService(input.service)
      if (!ACTIONS.includes(input.action)) throw fail('invalid_params', 'Unknown action')
      const bin = await docker()
      if (input.containerId === null) {
        // No container yet: only compose can create it (and may build or pull first).
        if (input.action !== 'start') throw fail('invalid_params', 'The service has no container')
        await run(bin, ['compose', 'up', '-d', service], { cwd: path, timeoutMs: 115_000 })
      } else {
        await run(bin, [input.action, checkContainer(input.containerId)], { cwd: path, timeoutMs: 60_000 })
      }
      return { ok: true }
    }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    orca.panels.handle(name, (input: unknown) => (handler as (i: unknown) => Promise<unknown>)(input ?? {}))
  }
}
