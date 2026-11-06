import { assert, test } from 'orca/testing'
import type { LogAnswer, LogLine } from '../src/protocol'
import { LogBuffer } from './log-buffer'

const line = (m: string, t = '2026-01-01T00:00:01.000000001Z', id = 'a'): LogLine => ({ t, m, e: false, containerId: id })
const answer = (lines: LogLine[], fields: Partial<LogAnswer> = {}): LogAnswer => ({ lines, clearedAt: null, truncated: false, errors: [], limits: [], ...fields })
const targets = [{ service: 'app', containerId: 'a', name: 'app' }]

test('deduplicates inclusive cursors without losing repeated identical lines', () => {
  const buffer = new LogBuffer()
  const first = line('same')
  buffer.apply(answer([first, first]), targets, false, false)
  const batch = answer([first, first, first, line('later', '2026-01-01T00:00:01.000000002Z')])
  buffer.apply(batch, targets, true, false)
  assert.deepEqual(buffer.lines.map((item) => item.m), ['same', 'same', 'same', 'later'])
  buffer.apply(batch, targets, true, false)
  assert.equal(buffer.lines.length, 4)
})

test('tracks independent source cursors and keeps healthy logs when another source fails', () => {
  const buffer = new LogBuffer()
  const both = [...targets, { service: 'db', containerId: 'b', name: 'db' }]
  buffer.apply(answer([line('app'), line('db', '2026-01-01T00:00:02.000000000Z', 'b')]), both, false, false)
  assert.deepEqual(buffer.targets(both).map((target) => target.cursor), ['2026-01-01T00:00:01.000000001Z', '2026-01-01T00:00:02.000000000Z'])
  buffer.apply(answer([line('app new', '2026-01-01T00:00:03.000000000Z')], { errors: [{ containerId: 'b', name: 'db', message: 'removed' }] }), both, true, false)
  assert.equal(buffer.lines.length, 3)
  assert.equal(buffer.errors[0].name, 'db')
})

test('resets on Clear, prunes moving time windows, and reports retained history limits', () => {
  const buffer = new LogBuffer()
  buffer.apply(answer([line('old')]), targets, false, false)
  buffer.apply(answer([line('new', '2026-01-01T00:00:04.000000000Z')], { clearedAt: '2026-01-01T00:00:03.000Z' }), targets, true, false)
  assert.deepEqual(buffer.lines.map((item) => item.m), ['new'])
  buffer.apply(answer([] , { clearedAt: buffer.clearedAt }), [{ ...targets[0], since: '2026-01-01T00:00:05.000Z' }], true, false)
  assert.equal(buffer.lines.length, 0)
  buffer.apply(answer(Array.from({ length: 1002 }, (_, i) => line(String(i)))), targets, false, true)
  assert.equal(buffer.lines.length, 1000)
  assert.equal(buffer.truncated, true)
  assert.ok(buffer.limits.has('buffer'))
})

test('does not reinsert boundary lines evicted from the visible history', () => {
  const buffer = new LogBuffer()
  const batch = answer(Array.from({ length: 1002 }, (_, i) => line(String(i))))
  buffer.apply(batch, targets, false, true)
  const kept = buffer.lines.map((line) => line.m)
  buffer.apply(batch, targets, true, true)
  assert.deepEqual(buffer.lines.map((line) => line.m), kept)
})
