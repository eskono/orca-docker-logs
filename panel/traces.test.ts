import { assert, test } from 'orca/testing'
import { traceLines } from './traces'
import { analyze, logRecords } from './log-model'

test('keeps trace order and distinguishes known project, library, and unmapped frames', () => {
  const trace = traceLines('Error: failed\n  at middleware (/app/node_modules/x/index.js:1:2)\n  at handler (/app/src/main.ts:4:2)\n  at worker (/other/work.ts:9:1)', (file) => file === '/app/src/main.ts' ? 'src/main.ts' : null)!
  assert.deepEqual(trace.filter((line) => line.frame).map((line) => line.kind), ['library', 'project', 'unknown'])
  assert.equal(trace[1].text.includes('middleware'), true)
  assert.equal(traceLines('INFO ready', () => null), null)
})

test('groups a Node/Go traceback as a record without collapsing separate error occurrences', () => {
  const lines = ['Error: bad', '  at handler (/app/a.ts:1)', 'INFO ready', 'Error: bad', '  at handler (/app/a.ts:1)'].map((m) => ({ t: '2026-01-01T00:00:00Z', e: false, m }))
  const records = logRecords(analyze(lines))
  assert.equal(records.filter((record) => record.level === 'error').length, 2)
  assert.match(records[0].text, /at handler/)
  const go = analyze(['panic: failed', 'goroutine 1 [running]:', 'main.main()', '\t/app/main.go:12'].map((m) => ({ t: '', e: false, m })))
  assert.deepEqual(go.map((line) => line.level), ['error', 'error', 'error', 'error'])
})
