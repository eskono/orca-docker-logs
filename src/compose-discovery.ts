import { open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

const COMPOSE_NAME = /^(?:docker-)?compose(?:[._-].+)?\.ya?ml$/i
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', '.cache', '.orca'])
const MAX_ENTRIES = 20_000
const MAX_DIRECTORIES = 1000

/** Recognize custom names such as docker/dev.yml without treating every YAML file as Compose. */
async function composeContent(path: string): Promise<boolean> {
  const file = await open(path, 'r').catch(() => null)
  if (!file) return false
  try {
    const buffer = Buffer.alloc(65_536)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const text = buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '')
    if (/^(?:services|include|['"](?:services|include)['"])\s*:/m.test(text)) return true
    if (!text.trimStart().startsWith('{')) return false
    try {
      const value = JSON.parse(text)
      return !!value && typeof value === 'object' && (Object.hasOwn(value, 'services') || Object.hasOwn(value, 'include'))
    } catch { return false }
  } finally { await file.close() }
}

/** A bounded breadth-first scan; symlinks are not followed and paths remain workspace-relative. */
export async function discoverComposeFiles(path: string, limit = 200, signal?: AbortSignal): Promise<{ files: string[]; envFiles: string[]; truncated: boolean }> {
  const files: string[] = []
  const envFiles: string[] = []
  const answer = (truncated: boolean) => ({ files: files.sort(), envFiles: envFiles.sort(), truncated })
  const directories = ['']
  let entries = 0, visited = 0
  while (directories.length) {
    signal?.throwIfAborted()
    if (++visited > MAX_DIRECTORIES) return answer(true)
    const current = directories.shift()!
    const directory = await opendir(join(path, current)).catch(() => null)
    if (!directory) continue
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (++entries > MAX_ENTRIES) return answer(true)
      const relative = current ? `${current}/${entry.name}` : entry.name
      if (relative.length > 1024 || /[\x00-\x1f]/.test(relative) || relative.startsWith('-')) continue
      if (entry.isDirectory() && !SKIP.has(entry.name)) directories.push(relative)
      if (!entry.isFile()) continue
      if (/^(?:\.env(?:[._-].+)?|.+\.env(?:[._-].+)?)$/i.test(entry.name)) {
        if (envFiles.length === 200) return answer(true)
        envFiles.push(relative)
      }
      if (!/\.ya?ml$/i.test(entry.name)) continue
      if (!COMPOSE_NAME.test(entry.name) && !await composeContent(join(path, relative))) continue
      if (files.length === limit) return answer(true)
      files.push(relative)
      if (limit === 1) return answer(true)
    }
  }
  return answer(false)
}
