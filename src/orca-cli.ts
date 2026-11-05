// The `orca` CLI, for what Orca's plugin API does not offer: which workspace a terminal belongs
// to, bringing a terminal to the front, and opening a file at a line.
import { dirname, join } from 'node:path'
import { run } from './docker'

/** The CLI inside the app bundle the worker runs from, then whatever `orca` is on PATH. */
function candidates(): string[] {
  const bundled = join(dirname(process.execPath), '..', 'Resources', 'bin', 'orca')
  return process.platform === 'darwin' ? [bundled, 'orca'] : ['orca']
}

/** Runs `orca <args> --json` and returns its `result`; rejects when no CLI answers. */
export async function orcaCli(args: string[], timeoutMs = 5000): Promise<unknown> {
  let failure: unknown = new Error('orca CLI not found')
  for (const cli of candidates()) {
    try {
      const { stdout } = await run(cli, [...args, '--json'], { timeoutMs })
      const answer = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: { message?: string } }
      if (answer.ok === false) throw new Error(answer.error?.message ?? 'orca CLI failed')
      return answer.result
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/** Orca's terminal handles mapped to their workspace paths. */
export async function terminalPaths(): Promise<Map<string, string>> {
  const result = (await orcaCli(['terminal', 'list', '--limit', '500']).catch(() => null)) as { terminals?: unknown[] } | null
  const map = new Map<string, string>()
  for (const t of (result?.terminals ?? []) as { handle?: unknown; worktreePath?: unknown }[]) {
    if (typeof t.handle === 'string' && typeof t.worktreePath === 'string') map.set(t.handle, t.worktreePath)
  }
  return map
}

/**
 * Shows a terminal in Orca's window, switching to its workspace; answers why it could not. The plugin API opens terminals
 * in the background, which reads as "nothing happened" when the panel shows another workspace.
 */
export async function revealTerminal(terminalId: string): Promise<string | null> {
  return orcaCli(['terminal', 'switch', '--terminal', terminalId]).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
}

/** Opens a file of a workspace at a line in Orca's editor and switches to it. */
export async function openFile(workspacePath: string, file: string, line: number, column?: number): Promise<void> {
  const position = ['--line', String(line), ...(column ? ['--column', String(column)] : [])]
  await orcaCli(['file', 'open', file, ...position, '--worktree', `path:${workspacePath}`, '--focus'])
}
