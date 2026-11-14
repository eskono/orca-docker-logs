import { assert, test } from 'orca/testing'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeArgs, composeEnvFile, defaultOptions, validateOptions } from './compose'

test('root configs keep legacy defaults and explicit nested env files override automatic dotenv selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compose-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'compose.yaml'), 'services: {}')
  await writeFile(join(root, '.env'), 'COMPOSE_PROFILES=development')
  await writeFile(join(root, 'nested', '.env.prod'), 'COMPOSE_PROFILES=production')
  const legacy = { files: ['compose.yaml'], profiles: ['development'] }
  assert.deepEqual(await validateOptions(root, legacy), legacy)
  assert.deepEqual(defaultOptions(), { files: [], profiles: [] })
  const custom = await validateOptions(root, { files: ['compose.yaml'], profiles: [], envFile: 'nested/.env.prod', profileMode: 'manual' })
  assert.equal(await composeEnvFile(root, custom), 'nested/.env.prod')
  assert.deepEqual(composeArgs(custom, [], await composeEnvFile(root, custom)), ['compose', '--env-file', 'nested/.env.prod', '-f', 'compose.yaml'])
  await assert.rejects(validateOptions(root, { files: [], profiles: [], envFile: '../not-allowed.env' }), { code: 'invalid_params' })
  await symlink(join(root, '..'), join(root, 'outside'))
  await assert.rejects(validateOptions(root, { files: [], profiles: [], envFile: 'outside/not-allowed.env' }), { code: 'invalid_params' })
})
