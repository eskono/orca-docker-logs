// Which local workspaces have compose files, and which one is focused in Orca.
import { readdir } from 'node:fs/promises'
import { terminalPaths } from './orca-cli'
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
 * The focused workspace among `workspaces`, or null when it is not local or cannot be told apart.
 * The plugin API's focused context names its terminals but not its folder, so the terminals tell
 * apart workspaces that share a name and branch (every repository's `main`, say).
 */
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
