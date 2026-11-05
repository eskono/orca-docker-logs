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
  exitCode: number | null
  /** `healthy`, `unhealthy`, `starting` or empty. */
  health: string
  /** The last healthcheck's output while the container is not healthy. */
  healthLog: string
  startedAt: string | null
  finishedAt: string | null
  /** Published TCP ports on this machine. */
  ports: number[]
  /** Compose profiles the service belongs to; empty when it always runs. */
  profiles: string[]
  /** Whether the service builds its image (`build:` in the compose file). */
  build: boolean
}

/** Resource use of a running container, as `docker stats` prints it (`3.34%`, `323.5MiB`, ...). */
export type ContainerStats = { cpu: string; mem: string; memLimit: string; memPercent: string }

/**
 * One log line: docker timestamp (RFC 3339, UTC), whether it came from stderr, the message, and
 * the container it came from when several are shown together.
 */
export type LogLine = { t: string; e: boolean; m: string; src?: string }

/** A container whose log to read, from `since` (RFC 3339) when given. */
export type LogTarget = { service: string; containerId: string; name: string; since?: string }

/** Quick actions run in the background; `start` of a missing container and `build` open a terminal. */
export type ServiceAction = 'start' | 'stop' | 'restart' | 'build'
/** `up` opens a terminal (it may build or pull); `restart` and `down` run in the background. */
export type ProjectAction = 'up' | 'restart' | 'down'

export type Requests = {
  /** Local workspaces that have a compose file, and the focused one when it can be resolved. */
  'workspaces.list': {
    input: { context: FocusContext }
    output: { workspaces: Workspace[]; focused: Workspace | null }
  }
  /** Compose services of a workspace (every profile) with their containers. */
  'services.list': { input: { path: string; fresh?: boolean }; output: { project: string; rows: ServiceRow[] } }
  /** CPU and memory of running containers, keyed by container id. Takes a couple of seconds. */
  'stats.get': {
    input: { path: string; containerIds: string[] }
    output: { stats: Record<string, ContainerStats> }
  }
  /**
   * The newest log lines of one or more containers in time order, each after its service's
   * "cleared" mark. `clearedAt` is the latest mark among them.
   */
  'logs.get': {
    input: { path: string; targets: LogTarget[] }
    output: { lines: LogLine[]; clearedAt: string | null; truncated: boolean }
  }
  /** Hides everything logged so far by these services (`reset: true` shows it again). */
  'logs.clear': {
    input: { path: string; services: string[]; reset?: boolean }
    output: { clearedAt: string | null }
  }
  'service.action': {
    input: { path: string; service: string; containerId: string | null; action: ServiceAction }
    output: { terminalId: string | null }
  }
  'project.action': { input: { path: string; action: ProjectAction }; output: { terminalId: string | null } }
  /** Opens an Orca terminal with a shell inside a running container. */
  'container.shell': { input: { path: string; containerId: string; name: string }; output: { terminalId: string } }
  /** Which paths from a service's stack traces are files of the project (project-relative), or null. */
  'code.resolve': {
    input: { path: string; service: string; files: string[] }
    output: { files: Record<string, string | null> }
  }
  /** Opens the project file behind a stack trace path at its line in Orca's editor and shows it. */
  'code.open': {
    input: { path: string; service: string; file: string; line: number; column?: number }
    output: { opened: string }
  }
  /** Starts an agent in the workspace with these log lines and asks it to find the cause. */
  'agent.ask': {
    input: { path: string; source: string; lines: string[] }
    output: { terminalId: string; agent: string }
  }
}
