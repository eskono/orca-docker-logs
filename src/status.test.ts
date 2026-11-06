import { assert, test } from 'orca/testing'
import type { ServiceRow } from './protocol'
import { NOTIFY_COOLDOWN_MS, ProblemTracker, problemOf, summarize } from './status'

function row(fields: Partial<ServiceRow>): ServiceRow {
  return {
    key: fields.containerId ?? `service:${fields.service ?? 'x'}`,
    service: 'x',
    containerId: null,
    name: 'proj-x-1',
    state: 'running',
    exitCode: 0,
    oomKilled: false,
    restartCount: 0,
    stateError: '',
    portBindings: [],
    health: '',
    healthLog: '',
    startedAt: null,
    finishedAt: null,
    ports: [],
    profiles: [],
    build: false,
    ...fields
  }
}

test('crashes and bad health are problems; stopping a container is not', () => {
  assert.equal(problemOf(row({ state: 'exited', exitCode: 1 })), 'exited with code 1')
  assert.equal(problemOf(row({ state: 'exited', exitCode: 143 })), null)
  assert.equal(problemOf(row({ state: 'exited', exitCode: 0 })), null)
  assert.equal(problemOf(row({ state: 'restarting' })), 'keeps restarting')
  assert.equal(problemOf(row({ state: 'running', health: 'unhealthy' })), 'is unhealthy')
  assert.equal(problemOf(row({ state: 'running', health: 'healthy' })), null)
})

test('summarizes running containers, leaving out services of inactive profiles', () => {
  const rows = [
    row({ containerId: 'a', name: 'p-app-1', state: 'running' }),
    row({ containerId: 'b', name: 'p-db-1', state: 'exited', exitCode: 2 }),
    row({ service: 'web', state: 'not created', profiles: ['web'] }),
    row({ service: 'job', state: 'not created' })
  ]
  assert.deepEqual(summarize('p', rows), {
    text: '1/3',
    tone: 'danger',
    tooltip: 'p: 1 of 3 running\np-db-1 exited with code 2'
  })
  assert.equal(summarize('p', [row({ containerId: 'a' })]).tone, 'success')
})

test('notifies once when a problem appears, not for what was already wrong', () => {
  const tracker = new ProblemTracker()
  const crashed = row({ containerId: 'b', state: 'exited', exitCode: 1 })
  const running = row({ containerId: 'b', state: 'running' })
  assert.deepEqual(tracker.update([crashed], 0), []) // baseline
  assert.deepEqual(tracker.update([running], 1000), [])
  assert.deepEqual(tracker.update([crashed], 2000).map((f) => f.problem), ['exited with code 1'])
  assert.deepEqual(tracker.update([crashed], 3000), []) // still the same crash
  tracker.update([running], 4000)
  assert.deepEqual(tracker.update([crashed], 5000), []) // within the cooldown
  tracker.update([running], 6000)
  assert.equal(tracker.update([crashed], 6000 + NOTIFY_COOLDOWN_MS).length, 1)
  tracker.reset()
  assert.deepEqual(tracker.update([row({ containerId: 'c', state: 'dead' })], 0), [])
})

test('OOM and SIGKILL are visible failures and restart-count increases notify between polls', () => {
  assert.match(problemOf(row({ state: 'exited', exitCode: 137, oomKilled: true }))!, /out of memory/)
  assert.equal(problemOf(row({ state: 'exited', exitCode: 137 })), 'exited with code 137')
  const tracker = new ProblemTracker()
  tracker.update([row({ containerId: 'a', restartCount: 1 })], 0)
  const fresh = tracker.update([row({ containerId: 'a', restartCount: 2 })], 1000)
  assert.equal(fresh[0].problem, 'restarted unexpectedly')
  assert.equal(tracker.update([row({ containerId: 'a', restartCount: 2 })], 2000).length, 0)
})
