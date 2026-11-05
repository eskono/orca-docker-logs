// The panel <-> worker contract. panel/main.ts and src/worker.ts both import these types.

/** A local Orca workspace (worktree or folder). */
export type Workspace = { id: string; name: string; path: string; branch: string | null }

/** What `workspace.changed` / `workspace.readContext` report for the focused workspace. */
export type FocusContext = {
  displayName: string
  branch: string
  terminals: { id: string; title?: string }[]
} | null

/** One container of a compose service, or the service itself when it has no container yet. */
export type ServiceRow = {
  /** Container id, or `service:<name>` when the service has no container. */
  key: string
  service: string
  containerId: string | null
  /** Container name, or the service name when there is no container. */
  name: string
  /** Docker state (`running`, `exited`, `restarting`, ...) or `not created`. */
  state: string
  /** Docker's human status, e.g. `Up 3 minutes (healthy)`. */
  status: string
  /** `healthy`, `unhealthy`, `starting` or empty. */
  health: string
}

/** Resource use of a running container, as `docker stats` prints it (`3.34%`, `323.5MiB`, ...). */
export type ContainerStats = { cpu: string; mem: string; memLimit: string; memPercent: string }

/** One log line: docker timestamp (RFC 3339, UTC), whether it came from stderr, the message. */
export type LogLine = { t: string; e: boolean; m: string }

export type ServiceAction = 'start' | 'stop' | 'restart'

export type Requests = {
  /** Local workspaces that have a compose file, and the focused one when it can be resolved. */
  'workspaces.list': {
    input: { context: FocusContext }
    output: { workspaces: Workspace[]; focused: Workspace | null }
  }
  /** Compose services of a workspace with their containers' state. */
  'services.list': { input: { path: string }; output: { rows: ServiceRow[] } }
  /** CPU and memory of running containers, keyed by container id. Takes a couple of seconds. */
  'stats.get': {
    input: { path: string; containerIds: string[] }
    output: { stats: Record<string, ContainerStats> }
  }
  /** The newest log lines of a container, after the service's "cleared" mark if any. */
  'logs.get': {
    input: { path: string; service: string; containerId: string }
    output: { lines: LogLine[]; clearedAt: string | null; truncated: boolean }
  }
  /** Hides everything logged so far (`reset: true` shows it again). Docker's own log is untouched. */
  'logs.clear': {
    input: { path: string; service: string; reset?: boolean }
    output: { clearedAt: string | null }
  }
  /** Starts, stops or restarts a container; `start` without a container runs `compose up -d`. */
  'service.action': {
    input: { path: string; service: string; containerId: string | null; action: ServiceAction }
    output: { ok: true }
  }
}
