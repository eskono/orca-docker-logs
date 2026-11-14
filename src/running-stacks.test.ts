import { assert, test } from 'orca/testing'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchStacks, parseStackMetadata, profilesOfRunning } from './running-stacks'
import { parseConfig, parseInspect } from './docker'

test('matches root and nested stacks by workspace-contained config paths, never by project names alone', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'running-stacks-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['workspace', 'workspace/deploy', 'foreign']) await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, 'workspace/compose.yaml'), 'services: {}')
  await writeFile(join(root, 'workspace/deploy/compose.yml'), 'services: {}')
  await writeFile(join(root, 'workspace/deploy/.env.dev'), 'COMPOSE_PROFILES=dev')
  await writeFile(join(root, 'foreign/compose.yaml'), 'services: {}')
  await symlink(join(root, 'foreign/compose.yaml'), join(root, 'workspace/outside.yml'))
  const meta = (id: string, workingDir: string, files: string, extra = {}) => ({ id: id.repeat(64), project: 'same_name', service: 'api', state: 'running', workingDir, files, envFile: '', ...extra })
  const records = parseStackMetadata([
    meta('a', join(root, 'workspace'), join(root, 'workspace/compose.yaml')),
    meta('b', join(root, 'workspace/deploy'), join(root, 'workspace/deploy/compose.yml'), { envFile: join(root, 'workspace/deploy/.env.dev') }),
    meta('c', join(root, 'foreign'), join(root, 'foreign/compose.yaml')),
    meta('d', join(root, 'workspace'), join(root, 'workspace/outside.yml')),
    meta('e', join(root, 'workspace'), join(root, 'workspace/missing.yml'))
  ].map((record) => JSON.stringify(record)).join('\n'))
  const stacks = await matchStacks(join(root, 'workspace'), records)
  assert.equal(stacks.length, 2)
  assert.deepEqual(stacks.flatMap((stack) => stack.files).sort(), ['compose.yaml', 'deploy/compose.yml'])
  assert.equal(stacks.find((stack) => stack.files[0].startsWith('deploy'))!.envFile, 'deploy/.env.dev')
  assert.equal(new Set(stacks.map((stack) => stack.id)).size, 2)
})

test('maps every profile membership of running services, keeps ambiguity, and excludes stopped services', () => {
  const config = parseConfig(JSON.stringify({ name: 'project', services: {
    api: { profiles: ['dev', 'shared'] }, worker: { profiles: ['jobs'] }, db: {}
  } }))
  const containers = parseInspect(JSON.stringify([
    { Id: 'a'.repeat(64), State: { Status: 'running' }, Config: { Labels: { 'com.docker.compose.service': 'api' } } },
    { Id: 'b'.repeat(64), State: { Status: 'running' }, Config: { Labels: { 'com.docker.compose.service': 'api' } } },
    { Id: 'c'.repeat(64), State: { Status: 'exited' }, Config: { Labels: { 'com.docker.compose.service': 'worker' } } }
  ]))
  assert.deepEqual(profilesOfRunning(config, containers), [{ name: 'dev', services: ['api'] }, { name: 'shared', services: ['api'] }])
  assert.deepEqual(parseStackMetadata('not-json\n{}\n'), [])
})
