import { assert, test } from 'orca/testing'
import { buildRows, byTime, containerLines, newestWithin, parseConfig, parseInspect, parseStats, shellQuote } from './docker'

const APP = 'a'.repeat(64)

const inspectEntry = {
  Id: APP,
  Name: '/proj-app-1',
  State: {
    Status: 'running',
    ExitCode: 0,
    StartedAt: '2026-11-05T09:00:00.123456789Z',
    FinishedAt: '0001-01-01T00:00:00Z',
    Health: { Status: 'unhealthy', Log: [{ Output: 'old' }, { Output: 'curl: (7) refused\n' }] }
  },
  Config: { Labels: { 'com.docker.compose.service': 'app', 'com.docker.compose.project': 'proj' } },
  NetworkSettings: {
    Ports: {
      '8000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8000' }, { HostIp: '::', HostPort: '8000' }],
      '5432/tcp': null,
      '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }],
      '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3001' }]
    }
  }
}

test('reads the compose model: project name, profiles and which services build', () => {
  const config = parseConfig(
    JSON.stringify({ name: 'proj', services: { app: { build: { context: '.' } }, caddy: { profiles: ['web'], image: 'caddy' } } })
  )
  assert.deepEqual(config, {
    name: 'proj',
    services: { app: { profiles: [], build: true }, caddy: { profiles: ['web'], build: false } }
  })
  assert.throws(() => parseConfig('{"services":{}}'))
})

test('reads containers from docker inspect', () => {
  const [app] = parseInspect(JSON.stringify([inspectEntry, { Id: 'x', Config: { Labels: {} } }]))
  const [stopped] = parseInspect(JSON.stringify([{ ...inspectEntry, State: { ...inspectEntry.State, Status: 'exited' } }]))
  assert.deepEqual([stopped.health, stopped.healthLog], ['', ''])
  assert.deepEqual(app, {
    id: APP,
    name: 'proj-app-1',
    service: 'app',
    state: 'running',
    exitCode: 0,
    health: 'unhealthy',
    healthLog: 'curl: (7) refused',
    startedAt: '2026-11-05T09:00:00.123456789Z',
    finishedAt: null,
    ports: [3001, 8000]
  })
})

test('lists services with their containers, placeholders and orphans', () => {
  const config = { name: 'proj', services: { app: { profiles: [], build: true }, caddy: { profiles: ['web'], build: false } } }
  const [app] = parseInspect(JSON.stringify([inspectEntry]))
  const orphan = { ...app, id: 'c'.repeat(64), name: 'proj-old-1', service: 'old' }
  const rows = buildRows(config, [app, orphan])
  assert.deepEqual(
    rows.map((r) => [r.key, r.service, r.state, r.profiles, r.build]),
    [
      [APP, 'app', 'running', [], true],
      ['service:caddy', 'caddy', 'not created', ['web'], false],
      ['c'.repeat(64), 'old', 'running', [], false]
    ]
  )
  assert.deepEqual(rows[0].ports, [3001, 8000])
  assert.equal(rows[1].containerId, null)
})

test('tags and interleaves log lines of several containers by timestamp', () => {
  const app = containerLines('2026-01-01T00:00:01.000000000Z a1\n2026-01-01T00:00:03.000000000Z a3\n', '', 'app-1')
  const db = containerLines('', '2026-01-01T00:00:02.000000000Z \u001b[31md2\u001b[0m\n', 'db-1')
  assert.deepEqual(byTime([...app, ...db]), [
    { t: '2026-01-01T00:00:01.000000000Z', e: false, m: 'a1', src: 'app-1' },
    { t: '2026-01-01T00:00:02.000000000Z', e: true, m: '\u001b[31md2\u001b[0m', src: 'db-1' },
    { t: '2026-01-01T00:00:03.000000000Z', e: false, m: 'a3', src: 'app-1' }
  ])
  assert.deepEqual(containerLines('2026-01-01T00:00:01.000000000Z one\n', ''), [
    { t: '2026-01-01T00:00:01.000000000Z', e: false, m: 'one' }
  ])
})

test('keeps the newest lines that fit the answer budget', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({ t: `2026-01-01T00:00:0${i}.000000000Z`, e: false, m: 'x'.repeat(100) }))
  const one = Buffer.byteLength(JSON.stringify(lines[0])) + 1
  const kept = newestWithin(lines, one * 3)
  assert.equal(kept.truncated, true)
  assert.deepEqual(kept.lines, lines.slice(7))
  assert.deepEqual(newestWithin(lines, 1_000_000), { lines, truncated: false })
  const huge = newestWithin([{ t: 'x', e: false, m: 'y'.repeat(10_000) }], 800)
  assert.equal(huge.truncated, true)
  assert.equal(huge.lines[0].m.length, 100)
})

test('reads docker stats lines keyed by full container id', () => {
  const line = { ID: APP, CPUPerc: '3.34%', MemUsage: '323.5MiB / 11.68GiB', MemPerc: '2.70%' }
  assert.deepEqual(parseStats(`${JSON.stringify(line)}\n\n`), {
    [APP]: { cpu: '3.34%', mem: '323.5MiB', memLimit: '11.68GiB', memPercent: '2.70%' }
  })
})

test('quotes shell arguments only when needed', () => {
  assert.equal(shellQuote('/usr/local/bin/docker'), '/usr/local/bin/docker')
  assert.equal(shellQuote('My Project'), `'My Project'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('a;rm -rf ~'), `'a;rm -rf ~'`)
})
