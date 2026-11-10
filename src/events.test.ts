import { assert, test } from 'orca/testing'
import { Events, parseDockerEvent, type EventScope, type EventStream } from './events'

const id = 'a'.repeat(64)
const raw = (action = 'start', nanos = '1767225600123456789', dir = '/project') => `{"Type":"container","Action":${JSON.stringify(action)},"Actor":{"ID":"${id}","Attributes":{"name":"proj-app-1","com.docker.compose.service":"app","com.docker.compose.project":"proj","com.docker.compose.project.working_dir":"${dir}","exitCode":"137"}},"timeNano":${nanos}}`
const scope: EventScope = { path: '/project', binary: '/usr/bin/docker', project: 'proj', context: 'default', prefix: ['--context', 'default'] }
function fixture() {
  const data = new Map<string, unknown>()
  const calls: { args: string[]; line: (s: string) => void; error: (s: string) => void; stopped: boolean }[] = []
  const storage = { async get(key: string) { return structuredClone(data.get(key)) }, async set(key: string, value: unknown) { data.set(key, structuredClone(value)) } }
  const stream: EventStream = (_binary, args, line, error) => { const call = { args, line, error, stopped: false }; calls.push(call); return () => { call.stopped = true } }
  return { storage, stream, calls, data }
}

test('parses lifecycle, OOM and health events without rounding nanoseconds', () => {
  const parsed = parseDockerEvent(raw('health_status: unhealthy'))!
  assert.equal(parsed.event.t, '2026-01-01T00:00:00.123456789Z')
  assert.equal(parsed.event.action, 'health_status')
  assert.equal(parsed.event.detail, 'unhealthy')
  assert.equal(parsed.workingDir, '/project')
  assert.equal(parseDockerEvent(raw('oom'))?.event.action, 'oom')
  assert.equal(parseDockerEvent(raw('exec_create')), null)
  assert.equal(parseDockerEvent(raw().replace('com.docker.compose.project.working_dir', 'missing')), null)
  assert.equal(parseDockerEvent('{invalid'), null)
})

test('deduplicates reconnect overlap, ignores foreign workspaces and persists events after container removal', async () => {
  const f = fixture()
  const history = new Events(f.storage, f.stream, async (path, parsed) => path === parsed.workingDir)
  await history.watch(scope)
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['--context', 'default', 'events', '--filter'])
  for (const text of [raw(), raw(), raw('oom', '1767225601123456789'), raw('destroy', '1767225602123456789'), raw('start', '1767225603123456789', '/foreign')]) f.calls[0].line(text)
  const answer = await history.watch(scope)
  assert.deepEqual(answer.events.map((event) => event.action), ['destroy', 'oom', 'start'])
  await history.dispose()
  assert.equal(f.calls[0].stopped, true)
  const restored = new Events(f.storage, f.stream)
  try {
    const answer = await restored.watch(scope)
    assert.equal(answer.events.length, 3)
    assert.equal(f.calls[1].args.at(-1), '2026-01-01T00:00:02.123456789Z')
    const other = await restored.watch({ ...scope, context: 'remote' })
    assert.equal(other.events.length, 0)
    assert.equal(f.calls[1].stopped, true)
  } finally { await restored.dispose() }
})

test('bounds retained event history, reports disconnection, and limits concurrent streams', async () => {
  const f = fixture()
  const history = new Events(f.storage, f.stream)
  try {
    await history.watch(scope)
    for (let i = 0; i < 230; i++) f.calls[0].line(raw('start', String(1767225600000000000n + BigInt(i))))
    const answer = await history.watch(scope)
    assert.ok(answer.events.length <= 200)
    assert.equal(answer.limited, true)
    await history.watch({ ...scope, path: '/second' })
    await history.watch({ ...scope, path: '/third' })
    assert.equal(f.calls.filter((call) => !call.stopped).length, 2)
    f.calls[2].error('Docker unavailable')
    const failed = await history.watch({ ...scope, path: '/third' })
    assert.equal(failed.connected, false)
    assert.equal(failed.error, 'Docker unavailable')
  } finally { await history.dispose() }
})
