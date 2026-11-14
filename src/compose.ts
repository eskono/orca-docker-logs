import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fail } from './docker'
import type { ComposeOptions } from './protocol'

export const defaultOptions = (): ComposeOptions => ({ files: [], profiles: [] })

export function composeArgs(options: ComposeOptions, profiles = options.profiles, envFile?: string): string[] {
  return ['compose', ...(envFile ? ['--env-file', envFile] : []), ...options.files.flatMap((file) => ['-f', file]), ...[...new Set(profiles)].flatMap((p) => ['--profile', p]), ...(options.projectName ? ['-p', options.projectName] : [])]
}

/** Older Compose versions switch dotenv discovery to the first -f directory. Keep workspace
 * variables when selecting custom files, while preserving that file's build/bind path base. */
export async function composeEnvFile(path: string, options: ComposeOptions): Promise<string | undefined> {
  if (options.envFile) return options.envFile
  if (!options.files.length || process.env.COMPOSE_ENV_FILES || /^(true|1)$/i.test(process.env.COMPOSE_DISABLE_ENV_FILE ?? '')) return undefined
  return await stat(join(path, '.env')).then((entry) => entry.isFile() ? '.env' : undefined, () => undefined)
}

export async function validateOptions(path: string, value: ComposeOptions): Promise<ComposeOptions> {
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.profiles) || value.files.length > 10 || value.profiles.length > 50) {
    throw fail('invalid_params', 'Invalid Compose settings')
  }
  const root = await realpath(path)
  if (value.profileMode !== undefined && !['auto', 'manual'].includes(value.profileMode)) throw fail('invalid_params', 'Invalid profile mode')
  if (value.projectName !== undefined && (typeof value.projectName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,254}$/.test(value.projectName))) throw fail('invalid_params', 'Invalid Compose project name')
  const files: string[] = []
  for (const file of value.files) {
    if (typeof file !== 'string' || !file || file.length > 1024 || /[\x00-\x1f]/.test(file) || isAbsolute(file) || file.startsWith('-')) {
      throw fail('invalid_params', 'Compose files must be paths relative to the workspace')
    }
    const actual = await realpath(resolve(root, file)).catch(() => null)
    const rel = actual ? relative(root, actual) : '..'
    if (!actual || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(actual)).isFile()) {
      throw fail('invalid_params', `Compose file is not a file inside this workspace: ${file}`)
    }
    files.push(rel.split(sep).join('/'))
  }
  const profiles = value.profiles.map((profile) => {
    if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(profile)) {
      throw fail('invalid_params', 'Invalid Compose profile')
    }
    return profile
  })
  let envFile: string | undefined
  if (value.envFile !== undefined && value.envFile !== '') {
    const checked = await validateOptions(path, { files: [value.envFile], profiles: [] })
    envFile = checked.files[0]
  }
  return { files: [...new Set(files)], profiles: [...new Set(profiles)], ...(envFile ? { envFile } : {}), ...(value.profileMode ? { profileMode: value.profileMode } : {}), ...(value.projectName ? { projectName: value.projectName } : {}) }
}
