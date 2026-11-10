import { assert, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { operationMarker, Operations, trackedCommand } from './operations'

function fixture() {
  const data = new Map<string, unknown>()
  let output: string[] = []
  let unavailable = false
  const storage = { async get(key: string) { return structuredClone(data.get(key)) }, async set(key: string, value: unknown) { data.set(key, structuredClone(value)) } }
  const read = async () => { if (unavailable) throw new Error('terminal closed'); return { lines: output, truncated: false } }
  const tracker = new Operations(storage, read)
  return { tracker, storage, read, setOutput(lines: string[]) { output = lines }, close() { unavailable = true } }
}

test('terminal wrapper reports the Docker command’s real exit code and preserves quoted paths', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const result = spawnSync('/bin/sh', ['-c', trackedCommand("printf '%s\\n' \"it's a path\"; exit 7", id)], { encoding: 'utf8' })
  // Explicit exit belongs in a subshell, as Docker itself is an external command.
  const failure = spawnSync('/bin/sh', ['-c', trackedCommand("sh -c 'exit 7'", id)], { encoding: 'utf8' })
  assert.match(result.stdout, /it's a path/)
  assert.equal(failure.status, 7)
  assert.match(failure.stdout, new RegExp(`${operationMarker(id)} 7`))
})

test('tracks progress, blocks conflicting operations, and survives worker reloads without relaunching commands', async () => {
  const f = fixture()
  let creates = 0
  try {
    await f.tracker.terminal('/a', 'build api', 'api', 'docker build .', async () => { creates++; return 'terminal-1' })
    const running = (await f.tracker.list('/a'))[0]
    assert.equal(running.status, 'running')
    await assert.rejects(f.tracker.terminal('/a', 'build api', 'api', 'docker build .', async () => 'duplicate'), /already running/)
    f.setOutput(['[2/3] Building layer', operationMarker(running.id) + ' 1'])
    const finished = (await f.tracker.list('/a'))[0]
    assert.equal(finished.status, 'failed')
    assert.equal(finished.exitCode, 1)
    assert.deepEqual(finished.lines, ['[2/3] Building layer'])
    assert.equal(creates, 1)
    await f.tracker.dispose()
    const restored = new Operations(f.storage, f.read)
    try { assert.equal((await restored.list('/a'))[0].status, 'failed'); assert.equal((await restored.list('/b')).length, 0) }
    finally { await restored.dispose() }
    await assert.rejects(f.tracker.terminalFor('/b', running.id), { code: 'not_permitted' })
  } finally { await f.tracker.dispose() }
})

test('does not claim completion when a terminal disappears; background failures remain inspectable', async () => {
  const f = fixture()
  try {
    await f.tracker.terminal('/a', 'up', null, 'docker compose up', async () => 'terminal-1')
    f.close()
    assert.equal((await f.tracker.list('/a'))[0].status, 'unknown')
    await assert.rejects(f.tracker.run('/b', 'stop api', 'api', async () => { throw new Error('Docker is unavailable') }))
    const failed = (await f.tracker.list('/b'))[0]
    assert.equal(failed.status, 'failed')
    assert.match(failed.lines.join('\n'), /Docker is unavailable/)
  } finally { await f.tracker.dispose() }
})

test('a history write failure cannot turn a started or successful Docker command into a failed command', async () => {
  for (const terminal of [false, true]) {
    let writes = 0
    const tracker = new Operations({ async get() { return null }, async set() { if (++writes === 2) throw new Error('Storage unavailable') } }, async () => ({ lines: ['building'], truncated: false }))
    try {
      const run = terminal ? tracker.terminal('/project', 'build app', 'app', 'docker build .', async () => 'own-terminal') : tracker.run('/project', 'restart app', 'app', async () => ({ stdout: 'restarted', stderr: '' }))
      await assert.rejects(run, /Storage unavailable/)
      assert.equal((await tracker.list('/project'))[0].status, terminal ? 'running' : 'succeeded')
    } finally { await tracker.dispose() }
  }
})
