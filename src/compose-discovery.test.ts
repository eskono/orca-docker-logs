import { assert, test } from 'orca/testing'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverComposeFiles } from './compose-discovery'

test('finds nested configs, variants and custom YAML/JSON names without unrelated YAML or dependency folders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compose-tree-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['docker/local', '.docker/profiles', 'infra', 'node_modules/pkg', '.git', 'vendor']) await mkdir(join(root, dir), { recursive: true })
  const files: Record<string, string> = {
    'compose.yaml': 'services: {}',
    'docker/local/docker-compose.dev.yml': 'services: {}',
    '.docker/profiles/tools.yaml': 'services:\n  tools:\n    profiles: [tools]',
    'infra/stack.yml': '{"services": {}}',
    'infra/include.yml': 'include: [stack.yml]',
    'infra/settings.yml': 'app:\n  services: []',
    'infra/workflow.yml': 'jobs:\n  test:\n    services: {}',
    'node_modules/pkg/compose.yml': 'services: {}',
    '.git/compose.yml': 'services: {}',
    'vendor/compose.yml': 'services: {}'
  }
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)))
  assert.deepEqual(await discoverComposeFiles(root), { files: ['.docker/profiles/tools.yaml', 'compose.yaml', 'docker/local/docker-compose.dev.yml', 'infra/include.yml', 'infra/stack.yml'], truncated: false })
})

test('does not follow symlinks, reports scan limits and supports cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compose-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'workspace'))
  await mkdir(join(root, 'foreign'))
  await writeFile(join(root, 'foreign/compose.yml'), 'services: {}')
  await symlink(join(root, 'foreign'), join(root, 'workspace/linked'))
  await symlink(join(root, 'foreign/compose.yml'), join(root, 'workspace/compose.yml'))
  assert.deepEqual((await discoverComposeFiles(join(root, 'workspace'))).files, [])
  for (const name of ['compose.a.yml', 'compose.b.yaml', 'compose.c.yml']) await writeFile(join(root, 'workspace', name), 'services: {}')
  const limited = await discoverComposeFiles(join(root, 'workspace'), 2)
  assert.equal(limited.files.length, 2)
  assert.equal(limited.truncated, true)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(discoverComposeFiles(root, 200, controller.signal), { name: 'AbortError' })
})
