import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { resolveSource } from './sources'

async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-logs-src-')))
  const dir = join(root, 'proj')
  await mkdir(join(dir, 'app', 'core'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'express'), { recursive: true })
  await writeFile(join(dir, 'app', 'core', 'media.py'), '')
  await writeFile(join(dir, 'main.py'), '')
  await writeFile(join(dir, 'node_modules', 'express', 'index.js'), '')
  await writeFile(join(root, 'secret.txt'), '')
  await symlink(join(root, 'secret.txt'), join(dir, 'leak.txt'))
  return { root, dir }
}

test('maps a path through the service’s bind mount', async () => {
  const { dir } = await project()
  const mounts = [{ source: join(dir, 'app'), target: '/srv/app' }]
  assert.equal(await resolveSource(dir, mounts, '/srv/app/core/media.py'), 'app/core/media.py')
  assert.equal(await resolveSource(dir, mounts, '/srv/app/core/missing.py'), null)
})

test('finds code copied into the image by the longest existing tail of the path', async () => {
  const { dir } = await project()
  assert.equal(await resolveSource(dir, [], '/code/app/core/media.py'), 'app/core/media.py')
  assert.equal(await resolveSource(dir, [], '/workdir/main.py'), 'main.py')
})

test('never guesses into libraries or out of the project', async () => {
  const { dir, root } = await project()
  assert.equal(await resolveSource(dir, [], '/usr/lib/node_modules/express/index.js'), null)
  assert.equal(await resolveSource(dir, [{ source: root, target: '/data' }], '/data/secret.txt'), null)
  assert.equal(await resolveSource(dir, [], '/app/leak.txt'), null)
})
