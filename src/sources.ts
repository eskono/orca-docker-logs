// Which project file a path in a container's stack trace is.
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Mount } from './docker'

/** Third-party code: only a bind mount may point into it, a guess by file name may not. */
const LIBRARY_DIRS = new Set(['site-packages', 'dist-packages', 'node_modules', 'vendor', '.venv'])

/** `candidate` as a path relative to the project, when it is a file inside it (symlinks resolved). */
async function projectFile(project: string, candidate: string): Promise<string | null> {
  try {
    const real = await realpath(candidate)
    const rel = relative(project, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return (await stat(real)).isFile() ? rel.split(sep).join('/') : null
  } catch {
    return null
  }
}

/**
 * The project-relative path of `file`, a path inside the container, or null. A bind mount maps it
 * exactly; for code copied into the image, the longest tail of the path that exists in the project.
 */
export async function resolveSource(projectPath: string, mounts: Mount[], file: string): Promise<string | null> {
  const project = await realpath(projectPath)
  for (const mount of [...mounts].sort((a, b) => b.target.length - a.target.length)) {
    const target = mount.target.replace(/\/+$/, '')
    if (file.startsWith(`${target}/`)) {
      const found = await projectFile(project, join(mount.source, file.slice(target.length)))
      if (found) return found
    }
  }
  const parts = file.split('/').filter(Boolean)
  if (parts.some((part) => LIBRARY_DIRS.has(part))) return null
  for (let i = 0; i < parts.length; i++) {
    const found = await projectFile(project, join(project, ...parts.slice(i)))
    if (found) return found
  }
  return null
}
