import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import { composeArgs } from './compose'
import { fail, run } from './docker'
import type { ComposeOptions } from './protocol'

const CONTROL = ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE']
const exists = async (file: string) => stat(file).then((s) => s.isFile(), () => false)
async function defaultFiles(path: string): Promise<string[]> {
  for (let directory = path; ; directory = dirname(directory)) {
    for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
      const file = join(directory, name)
      if (!await exists(file)) continue
      const prefix = name.startsWith('docker-') ? 'docker-compose' : 'compose'
      const override = [join(directory, `${prefix}.override.yaml`), join(directory, `${prefix}.override.yml`)]
      return [file, ...(await exists(override[0]) ? [override[0]] : await exists(override[1]) ? [override[1]] : [])]
    }
    if (dirname(directory) === directory) throw fail('action_failed', 'No Compose file found; select one in Compose settings')
  }
}

/** Ask Compose to interpolate control variables, including on versions without --environment.
 * The temporary file contains references only. Resolved application values stay in memory;
 * only profile names and file paths leave this function. */
export async function composeEnvironment(path: string, bin: string, options: ComposeOptions, envFile?: string, signal?: AbortSignal): Promise<{ profiles: string[]; files: string[] }> {
  const temporary = await mkdtemp(join(tmpdir(), 'orca-compose-environment-'))
  try {
    const missing = `ORCA_UNSET_${randomUUID().replaceAll('-', '')}`
    // Only names are scanned here; Compose parses and interpolates the values, including quotes.
    const rootEnv = !options.files.length && !envFile ? await readFile(join(path, '.env'), 'utf8').catch(() => '') : ''
    const keys = [...new Set([...CONTROL, ...[...rootEnv.slice(0, 1_048_576).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]).slice(0, 1000)])]
    const probe = join(temporary, 'probe.json')
    const service = `orca_probe_${randomUUID().replaceAll('-', '')}`
    await writeFile(probe, JSON.stringify({ services: { [service]: { image: 'scratch', environment: Object.fromEntries(keys.map((key) => [key, '${' + key + '-' + missing + '}'])) } } }), { mode: 0o600 })
    const read = async (args: string[], env?: Record<string, string>) => {
      const result = await run(bin, [...args, '--profile', '*', 'config', '--format', 'json'], { cwd: path, timeoutMs: 20_000, signal, env })
      const values = JSON.parse(result.stdout).services?.[service]?.environment
      if (!values || typeof values !== 'object') throw fail('action_failed', 'Compose did not return resolved environment metadata')
      return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== missing))
    }
    let files = options.files
    let inherited: Record<string, string> | undefined
    if (!files.length) {
      const initial = await read([...composeArgs({ files: [], profiles: [] }, [], envFile), '--project-directory', path, '-f', probe])
      files = initial.COMPOSE_FILE ? initial.COMPOSE_FILE.split(initial.COMPOSE_PATH_SEPARATOR || delimiter).filter(Boolean).map((file) => isAbsolute(file) ? file : resolve(path, file)) : await defaultFiles(path)
      // Native automatic discovery can load a project-directory .env below the working .env.
      // Preserve the first file's resolved values as the higher-precedence layer in the probe.
      if (!envFile) inherited = initial
    }
    const values = await read([...composeArgs({ files, profiles: [] }, [], envFile), '-f', probe], inherited)
    return { profiles: [...new Set((values.COMPOSE_PROFILES ?? '').split(',').map((s) => s.trim()).filter(Boolean))], files }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
