// Configuration-only checks: Compose parses fixtures; no containers are created here.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { composeEnvironment } from '../src/compose-environment'
import { composeArgs, composeEnvFile } from '../src/compose'
import { run } from '../src/docker'

export async function checkRootAndNestedEnv(bin: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'orca-compose-env-check-'))
  try {
    await mkdir(join(root, 'nested'))
    const config = JSON.stringify({ services: {
      base: { image: 'scratch', environment: { PROFILE_VALUE: '${COMPOSE_PROFILES}' } },
      dev: { image: 'scratch', profiles: ['dev'] }, tools: { image: 'scratch', profiles: ['tools'] }
    } })
    await writeFile(join(root, 'compose.yaml'), config)
    await writeFile(join(root, 'compose.override.yaml'), JSON.stringify({ services: { base: { environment: { ROOT_OVERRIDE: 'root-only' } } } }))
    await writeFile(join(root, 'nested', 'compose.yaml'), config)
    await writeFile(join(root, '.env'), 'COMPOSE_PROJECT_NAME=orcaenvcheck\nSTAGE=dev\nCOMPOSE_PROFILES="${STAGE}"\nSECRET=not-for-ipc\n')
    await writeFile(join(root, 'nested', '.env'), 'COMPOSE_PROFILES=tools\n')
    await writeFile(join(root, 'nested', '.env.prod'), 'COMPOSE_PROFILES=tools\n')
    for (const [files, envFile, expected] of [[[], undefined, 'dev'], [['nested/compose.yaml'], undefined, 'dev'], [['nested/compose.yaml'], 'nested/.env.prod', 'tools']] as const) {
      const options = { files: [...files], profiles: [], ...(envFile ? { envFile } : {}) }
      const chosen = await composeEnvFile(root, options)
      const result = await composeEnvironment(root, bin, options, chosen)
      assert.deepEqual(result.profiles, [expected])
      assert.equal(JSON.stringify(result).includes('not-for-ipc'), false)
    }
    // Flags select services without rewriting the .env variable used for interpolation.
    for (const [profile, expected] of [['tools', ['base', 'tools']], ['orca_base_only', ['base']]] as const) {
      const result = await run(bin, [...composeArgs({ files: [], profiles: [] }, [profile]), 'config', '--format', 'json'], { cwd: root, timeoutMs: 20_000 })
      const model = JSON.parse(result.stdout)
      assert.deepEqual(Object.keys(model.services).sort(), [...expected])
      assert.equal(model.services.base.environment.PROFILE_VALUE, 'dev')
      assert.equal(model.services.base.environment.ROOT_OVERRIDE, 'root-only')
    }
    const nested = JSON.parse((await run(bin, ['compose', '--env-file', '.env', '-f', 'nested/compose.yaml', 'config', '--format', 'json'], { cwd: root, timeoutMs: 20_000 })).stdout)
    assert.equal(nested.services.base.environment.ROOT_OVERRIDE, undefined)
    await writeFile(join(root, '.env'), 'COMPOSE_FILE=nested/compose.yaml\nCOMPOSE_PROJECT_NAME=orcaenvcheck\n')
    const redirected = await composeEnvironment(root, bin, { files: [], profiles: [] })
    assert.deepEqual(redirected.profiles, ['tools'])
  } finally { await rm(root, { recursive: true, force: true }) }
}
