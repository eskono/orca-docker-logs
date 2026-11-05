// Runs the worker over a mock Orca host and a fake docker script that records its calls.
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const APP = 'a'.repeat(64)

const FAKE_DOCKER = `#!/bin/sh
here=$(dirname "$0")
echo "$(pwd)|$*" >> "$here/calls.log"
case "$1 $2" in
  "compose config") printf 'app\\nworker\\n' ;;
  "compose ps") printf '[{"ID":"${APP}","Name":"proj-app-1","Service":"app","State":"running","Status":"Up 1 minute","Health":""}]' ;;
  "compose up") ;;
  logs*)
    printf '2026-01-01T00:00:01.000000000Z out one\\n2026-01-01T00:00:03.000000000Z out two\\n'
    printf '2026-01-01T00:00:02.000000000Z err one\\n' >&2 ;;
  start*|stop*|restart*) echo "$2" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-logs-test-')))
  const project = join(root, 'project')
  const plain = join(root, 'plain')
  await Promise.all([mkdir(project), mkdir(plain)])
  await writeFile(join(project, 'docker-compose.yml'), 'services: {}\n')
  const docker = join(root, 'docker')
  await writeFile(docker, FAKE_DOCKER)
  await chmod(docker, 0o755)
  const host = mockHost({
    settings: { dockerPath: docker },
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'feature', path: project, branch: 'feature', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'main', path: plain, branch: 'main', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'remote', path: '/srv/x', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8')).trim().split('\n')
  return { worker, project, plain, calls }
}

test('lists compose workspaces and resolves the focused one', async () => {
  const { worker, project, plain } = await setup()
  const answer = await worker.request('workspaces.list', {
    context: { displayName: 'main', branch: 'main', terminals: [] }
  })
  assert.deepEqual(answer.workspaces.map((w: { path: string }) => w.path), [project])
  assert.equal(answer.focused?.path, plain)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reads services and containers with compose in the project folder', async () => {
  const { worker, project, calls } = await setup()
  const { rows } = await worker.request('services.list', { path: project })
  assert.deepEqual(
    rows.map((r: { service: string; state: string; containerId: string | null }) => [r.service, r.state, r.containerId]),
    [
      ['app', 'running', APP],
      ['worker', 'not created', null]
    ]
  )
  assert.deepEqual((await calls()).sort(), [
    `${project}|compose config --services`,
    `${project}|compose ps --all --format json`
  ])
  await worker.deactivate()
})

test('merges log streams and hides lines before a clear', async () => {
  const { worker, project, calls } = await setup()
  const input = { path: project, service: 'app', containerId: APP }
  const first = await worker.request('logs.get', input)
  assert.deepEqual(first.lines.map((l: { m: string; e: boolean }) => [l.m, l.e]), [
    ['out one', false],
    ['err one', true],
    ['out two', false]
  ])
  assert.equal(first.clearedAt, null)

  const { clearedAt } = await worker.request('logs.clear', { path: project, service: 'app' })
  assert.match(clearedAt, /^\d{4}-\d\d-\d\dT/)
  assert.equal((await worker.request('logs.get', input)).clearedAt, clearedAt)
  assert.equal((await calls()).at(-1)?.split('|')[1], `logs --timestamps --tail 1000 --since ${clearedAt} ${APP}`)

  assert.deepEqual(await worker.request('logs.clear', { path: project, service: 'app', reset: true }), { clearedAt: null })
  await worker.request('logs.get', input)
  assert.equal((await calls()).at(-1)?.split('|')[1], `logs --timestamps --tail 1000 ${APP}`)
  await worker.deactivate()
})

test('starts a service without a container through compose and acts on containers directly', async () => {
  const { worker, project, calls } = await setup()
  await worker.request('service.action', { path: project, service: 'worker', containerId: null, action: 'start' })
  await worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'restart' })
  assert.deepEqual(await calls(), [`${project}|compose up -d worker`, `${project}|restart ${APP}`])
  await worker.deactivate()
})

test('refuses folders that are not local workspaces and malformed names', async () => {
  const { worker, project } = await setup()
  await assert.rejects(worker.request('services.list', { path: '/srv/x' }), { code: 'not_permitted' })
  await assert.rejects(worker.request('services.list', { path: '/etc' }), { code: 'not_permitted' })
  await assert.rejects(
    worker.request('logs.get', { path: project, service: '--help', containerId: APP }),
    { code: 'invalid_params' }
  )
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: 'nope', action: 'stop' }),
    { code: 'invalid_params' }
  )
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'rm' as 'stop' }),
    { code: 'invalid_params' }
  )
  await worker.deactivate()
})
