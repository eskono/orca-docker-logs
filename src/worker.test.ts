// Runs the worker over a mock Orca host and a fake docker script that records its calls.
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const APP = 'a'.repeat(64)
const WORKER = 'b'.repeat(64)

const CONFIG = {
  name: 'proj',
  services: { app: { build: { context: '.' } }, worker: { image: 'busybox' }, caddy: { image: 'caddy', profiles: ['web'] } }
}

const INSPECT = [
  {
    Id: APP,
    Name: '/proj-app-1',
    State: { Status: 'running', ExitCode: 0, StartedAt: '2026-01-01T00:00:00.5Z', FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { Labels: { 'com.docker.compose.service': 'app' } },
    NetworkSettings: { Ports: { '8000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8000' }] } }
  },
  {
    Id: WORKER,
    Name: '/proj-worker-1',
    State: { Status: 'exited', ExitCode: 1, StartedAt: '2026-01-01T00:00:00Z', FinishedAt: '2026-01-01T00:00:09Z' },
    Config: { Labels: { 'com.docker.compose.service': 'worker' } },
    NetworkSettings: { Ports: {} }
  }
]

const FAKE_DOCKER = `#!/bin/sh
here=$(dirname "$0")
echo "$(pwd)|$*" >> "$here/calls.log"
case "$*" in
  "compose config --profiles") echo web ;;
  "compose --profile web config --format json") cat "$here/config.json" ;;
  "ps -aq --no-trunc --filter label=com.docker.compose.project=proj") printf '${APP}\\n${WORKER}\\n' ;;
  "inspect ${APP} ${WORKER}") cat "$here/inspect.json" ;;
  "logs "*"${APP}")
    printf '2026-01-01T00:00:01.000000000Z app one\\n2026-01-01T00:00:03.000000000Z app two\\n'
    printf '2026-01-01T00:00:02.000000000Z app err\\n' >&2 ;;
  "logs "*"${WORKER}") printf '2026-01-01T00:00:02.500000000Z worker crash\\n' ;;
  stats*) printf '{"ID":"${APP}","CPUPerc":"1.50%%","MemUsage":"10MiB / 1GiB","MemPerc":"0.98%%"}\\n' ;;
  "start "*|"stop "*|"restart "*) echo "$2" ;;
  "compose --profile web restart"|"compose --profile web down") ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`

/** Stands in for the `orca` CLI the worker calls to switch to the terminals it opens. */
const FAKE_ORCA = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/orca.log"
echo '{"ok":true,"result":{}}'
`

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-logs-test-')))
  const project = join(root, 'project')
  const plain = join(root, 'plain')
  await Promise.all([mkdir(project), mkdir(plain)])
  const docker = join(root, 'docker')
  await Promise.all([
    writeFile(join(project, 'compose.yaml'), 'services: {}\n'),
    writeFile(join(root, 'config.json'), JSON.stringify(CONFIG)),
    writeFile(join(root, 'inspect.json'), JSON.stringify(INSPECT)),
    writeFile(docker, FAKE_DOCKER)
  ])
  await chmod(docker, 0o755)
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'orca'), FAKE_ORCA)
  await chmod(join(root, 'bin', 'orca'), 0o755)
  process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`
  const host = mockHost({
    settings: { dockerPath: docker, agent: 'codex' },
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'feature', path: project, branch: 'feature', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'main', path: plain, branch: 'main', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'remote', path: '/srv/x', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      },
      'workspace.readContext': null,
      'terminal.create': { terminalId: 'term_1' },
      'agent.launch': { terminalId: 'term_2' },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host })
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  const args = async () => (await calls()).map((c) => c.split('|')[1])
  const orcaCalls = async () => (await readFile(join(root, 'bin', 'orca.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return { worker, host, project, plain, docker, calls, args, orcaCalls }
}

test('lists compose workspaces and resolves the focused one', async () => {
  const { worker, project, plain } = await setup()
  const answer = await worker.request('workspaces.list', { context: { displayName: 'main', branch: 'main', terminals: [] } })
  assert.deepEqual(answer.workspaces.map((w: { path: string }) => w.path), [project])
  assert.equal(answer.focused?.path, plain)
  await worker.deactivate()
})

test('lists every profile’s services with container state, ports and build flags', async () => {
  const { worker, project, calls } = await setup()
  const { project: name, rows } = await worker.request('services.list', { path: project })
  assert.equal(name, 'proj')
  type Row = { service: string; state: string; exitCode: number | null; ports: number[]; profiles: string[]; build: boolean }
  assert.deepEqual(
    rows.map((r: Row) => [r.service, r.state, r.exitCode, r.ports, r.profiles, r.build]),
    [
      ['app', 'running', 0, [8000], [], true],
      ['worker', 'exited', 1, [], [], false],
      ['caddy', 'not created', null, [], ['web'], false]
    ]
  )
  const log = await calls()
  assert.ok(log.includes(`${project}|compose config --profiles`))
  assert.ok(log.includes(`${project}|compose --profile web config --format json`))
  await worker.deactivate()
})

test('reads one container’s log, or several merged and tagged, after the cleared mark', async () => {
  const { worker, project, args } = await setup()
  const one = await worker.request('logs.get', { path: project, targets: [{ service: 'app', containerId: APP, name: 'proj-app-1' }] })
  assert.deepEqual(one.lines.map((l: { m: string; e: boolean; src?: string }) => [l.m, l.e, l.src]), [
    ['app one', false, undefined],
    ['app err', true, undefined],
    ['app two', false, undefined]
  ])
  assert.equal((await args()).at(-1), `logs --timestamps --tail 1000 ${APP}`)

  const both = await worker.request('logs.get', {
    path: project,
    targets: [
      { service: 'app', containerId: APP, name: 'proj-app-1', since: '2026-01-01T00:00:00Z' },
      { service: 'worker', containerId: WORKER, name: 'proj-worker-1' }
    ]
  })
  assert.deepEqual(both.lines.map((l: { m: string; src?: string }) => `${l.src}: ${l.m}`), [
    'proj-app-1: app one',
    'proj-app-1: app err',
    'proj-worker-1: worker crash',
    'proj-app-1: app two'
  ])
  const recent = await args()
  assert.ok(recent.includes(`logs --timestamps --tail 5000 --since 2026-01-01T00:00:00Z ${APP}`))
  assert.ok(recent.includes(`logs --timestamps --tail 500 ${WORKER}`))

  const { clearedAt } = await worker.request('logs.clear', { path: project, services: ['app', 'worker'] })
  await worker.request('logs.get', { path: project, targets: [{ service: 'worker', containerId: WORKER, name: 'proj-worker-1' }] })
  assert.equal((await args()).at(-1), `logs --timestamps --tail 1000 --since ${clearedAt} ${WORKER}`)
  assert.deepEqual(await worker.request('logs.clear', { path: project, services: ['worker'], reset: true }), { clearedAt: null })
  await worker.deactivate()
})

test('samples CPU and memory of the given containers only', async () => {
  const { worker, project, args } = await setup()
  assert.deepEqual(await worker.request('stats.get', { path: project, containerIds: [] }), { stats: {} })
  const { stats } = await worker.request('stats.get', { path: project, containerIds: [APP] })
  assert.deepEqual(stats, { [APP]: { cpu: '1.50%', mem: '10MiB', memLimit: '1GiB', memPercent: '0.98%' } })
  assert.deepEqual(await args(), [`stats --no-stream --no-trunc --format {{json .}} ${APP}`])
  await worker.deactivate()
})

test('acts on containers in the background and opens terminals for long compose commands', async () => {
  const { worker, host, project, docker, args, orcaCalls } = await setup()
  assert.deepEqual(
    await worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'restart' }),
    { terminalId: null }
  )
  assert.equal((await args()).at(-1), `restart ${APP}`)

  await worker.request('service.action', { path: project, service: 'caddy', containerId: null, action: 'start' })
  await worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'build' })
  await worker.request('project.action', { path: project, action: 'up' })
  await worker.request('container.shell', { path: project, containerId: APP, name: 'proj-app-1' })
  type Params = { workspaceId: string; title: string; command: string }
  const terminals = host.callsOf('terminal.create') as Params[]
  assert.deepEqual(
    terminals.map((t: Params) => [t.workspaceId, t.title]),
    [
      ['w1', 'up caddy'],
      ['w1', 'build app'],
      ['w1', 'compose up'],
      ['w1', 'shell proj-app-1']
    ]
  )
  assert.deepEqual(
    terminals.map((t: Params) => t.command),
    [
      `cd ${project} && ${docker} compose --profile web up -d caddy`,
      `cd ${project} && ${docker} compose up -d --build app`,
      `cd ${project} && ${docker} compose up -d`,
      `cd ${project} && ${docker} exec -it ${APP} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
    ]
  )

  // Orca opens them in the background; the worker brings each to the front.
  assert.deepEqual(await orcaCalls(), Array(4).fill('terminal switch --terminal term_1 --json'))

  assert.deepEqual(await worker.request('project.action', { path: project, action: 'down' }), { terminalId: null })
  assert.equal((await args()).at(-1), 'compose --profile web down')
  await worker.deactivate()
})

test('asks the configured agent about the log lines in a fence they cannot break', async () => {
  const { worker, host, project, orcaCalls } = await setup()
  const answer = await worker.request('agent.ask', {
    path: project,
    source: 'container "proj-worker-1"',
    lines: ['09:00:01 ok', '09:00:02 ERROR ```boom```']
  })
  assert.deepEqual(answer, { terminalId: 'term_2', agent: 'codex' })
  const [params] = host.callsOf('agent.launch') as { workspaceId: string; agent: string; prompt: string }[]
  assert.equal(params.workspaceId, 'w1')
  assert.equal(params.agent, 'codex')
  assert.match(params.prompt, /container "proj-worker-1"/)
  assert.ok(params.prompt.endsWith('````text\n09:00:01 ok\n09:00:02 ERROR ```boom```\n````'))
  assert.deepEqual(await orcaCalls(), ['terminal switch --terminal term_2 --json'])
  await assert.rejects(worker.request('agent.ask', { path: project, source: 'x', lines: [] }), { code: 'invalid_params' })
  await worker.deactivate()
})

test('shows the focused project in the status bar', async () => {
  const { worker, host } = await setup()
  await worker.emit('workspace.changed', { context: { displayName: 'feature', branch: 'feature', terminals: [] } })
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), {
    id: 'containers',
    text: '1/2',
    tone: 'danger',
    tooltip: 'proj: 1 of 2 running\nproj-worker-1 exited with code 1',
    visible: true
  })
  assert.equal(host.callsOf('notifications.show').length, 0) // already broken when focused: no alert
  await worker.emit('workspace.changed', { context: { displayName: 'main', branch: 'main', terminals: [] } })
  assert.deepEqual(host.callsOf('statusBar.update').at(-1), { id: 'containers', visible: false })
  await worker.deactivate()
})

test('refuses folders that are not local workspaces and malformed input', async () => {
  const { worker, project } = await setup()
  await assert.rejects(worker.request('services.list', { path: '/srv/x' }), { code: 'not_permitted' })
  await assert.rejects(worker.request('services.list', { path: '/etc' }), { code: 'not_permitted' })
  const target = { service: 'app', containerId: APP, name: 'proj-app-1' }
  await assert.rejects(worker.request('logs.get', { path: project, targets: [{ ...target, service: '--help' }] }), { code: 'invalid_params' })
  await assert.rejects(worker.request('logs.get', { path: project, targets: [{ ...target, since: '5m; rm' }] }), { code: 'invalid_params' })
  await assert.rejects(worker.request('logs.get', { path: project, targets: [] }), { code: 'invalid_params' })
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: 'nope', action: 'stop' }),
    { code: 'invalid_params' }
  )
  await assert.rejects(
    worker.request('service.action', { path: project, service: 'app', containerId: APP, action: 'rm' as 'stop' }),
    { code: 'invalid_params' }
  )
  await assert.rejects(worker.request('project.action', { path: project, action: 'rm' as 'up' }), { code: 'invalid_params' })
  await assert.rejects(worker.request('container.shell', { path: project, containerId: APP, name: 'a b' }), { code: 'invalid_params' })
  await worker.deactivate()
})
