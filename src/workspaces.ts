// Which local workspaces have compose files, and which one is focused in Orca.
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { run } from './docker'
import type { FocusContext, Workspace } from './protocol'

/** compose.yaml, docker-compose.yml, compose.override.yaml, docker-compose.dev.yml, ... */
const COMPOSE_FILE = /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i

export type ListedWorkspace = Workspace & { hostId: string | null }

/** `workspace.list` answers `refs/heads/x`-free names, `readContext` may not; folders have none. */
export function normalizeBranch(branch: string | null | undefined): string | null {
  return (branch?.replace(/^refs\/heads\//, '') ?? '') || null
}

/** Docker runs on this machine, so only workspaces on this machine qualify. */
export function localOnly(workspaces: ListedWorkspace[]): Workspace[] {
  return workspaces
    .filter((w) => w.hostId === null || w.hostId === 'local')
    .map(({ id, name, path, branch }) => ({ id, name, path, branch }))
}

export async function hasComposeFile(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).some((name) => COMPOSE_FILE.test(name))
  } catch {
    return false
  }
}

/**
 * Orca's terminal handles mapped to their workspace paths, from `orca terminal list`. The plugin
 * API's focused context names its terminals but not its path, so this tells apart workspaces
 * that share a name and branch (every repo's `main`, say).
 */
export async function terminalPaths(): Promise<Map<string, string>> {
  const bundled = join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca')
  for (const cli of process.platform === 'darwin' ? [bundled, 'orca'] : ['orca']) {
    try {
      const { stdout } = await run(cli, ['terminal', 'list', '--limit', '500', '--json'], { timeoutMs: 5000 })
      const terminals = (JSON.parse(stdout) as { result?: { terminals?: unknown[] } }).result?.terminals ?? []
      const map = new Map<string, string>()
      for (const t of terminals as { handle?: unknown; worktreePath?: unknown }[]) {
        if (typeof t.handle === 'string' && typeof t.worktreePath === 'string') map.set(t.handle, t.worktreePath)
      }
      return map
    } catch {
      // Try the next location; no CLI just means the panel asks the person to pick.
    }
  }
  return new Map()
}

/** The focused workspace among `workspaces`, or null when it is not local or cannot be told apart. */
export async function resolveFocused(
  context: FocusContext,
  workspaces: Workspace[],
  lookupTerminals: () => Promise<Map<string, string>> = terminalPaths
): Promise<Workspace | null> {
  if (!context) return null
  const branch = normalizeBranch(context.branch)
  const matches = workspaces.filter((w) => w.name === context.displayName && normalizeBranch(w.branch) === branch)
  if (matches.length <= 1) return matches[0] ?? null
  if (context.terminals.length === 0) return null
  const paths = await lookupTerminals()
  for (const terminal of context.terminals) {
    const match = matches.find((w) => w.path === paths.get(terminal.id))
    if (match) return match
  }
  return null
}
