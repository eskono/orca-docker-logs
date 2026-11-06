import { assert, test } from 'orca/testing'
import { analyze, groupErrors, incidentLines, isCorrelation, matchesFilter } from './log-model'

const log = (m: string, containerId = 'api') => ({ t: '2026-01-01T00:00:01.000000000Z', m, e: false, containerId, src: containerId })
test('keeps traceback levels separate for interleaved containers', () => {
  assert.deepEqual(analyze([log('ERROR api'), log('  normal db detail', 'db'), log('INFO db ready', 'db'), log('  at /app/a.ts:2')]).map((item) => item.level), ['error', null, null, 'error'])
})
test('filters nested JSON fields and quoted correlation IDs without matching unrelated messages', () => {
  const [item] = analyze([log('{"level":"error","trace_id":"abc 123","request":{"id":42},"msg":"Failed payment"}')])
  assert.equal(matchesFilter(item, 'trace_id="abc 123" payment'), true)
  assert.equal(matchesFilter(item, 'request.id=42'), true)
  assert.equal(matchesFilter(item, 'trace_id=other'), false)
  assert.equal(matchesFilter(analyze([log('INFO http://localhost:8000 ready')])[0], 'http://localhost:8000'), true)
  assert.equal(matchesFilter(analyze([log('level=error request_id=abc msg=failed')])[0], 'request_id=abc'), true)
  assert.equal(isCorrelation('context.traceId'), true)
  assert.equal(analyze([log('{broken')])[0].fields, null)
})
test('groups repeated errors with complete traces without merging different sources', () => {
  const records = analyze([
    log('ERROR failed'), log('Traceback (most recent call last):'), log('  File "/app/main.py", line 2'), log('ValueError: bad'), log('INFO next'),
    log('ERROR failed'), log('Traceback (most recent call last):'), log('  File "/app/main.py", line 2'), log('ValueError: bad'), log('INFO done'),
    log('ERROR failed', 'other')
  ])
  const grouped = groupErrors(records)
  assert.equal(grouped[0].count, 2)
  assert.match(grouped[0].text, /File "\/app\/main.py"/)
  assert.match(grouped[0].text, /ValueError: bad/)
  assert.equal(grouped.at(-1)?.count, 1)
})
test('Ask agent retains unfiltered context and traceback from the affected source', () => {
  const all = analyze([log('INFO request received'), log('ERROR failed'), log('INFO other', 'db'), log('  at /app/main.ts:2'), log('INFO request finished')])
  const incident = incidentLines(all, all.filter((item) => item.level))
  assert.deepEqual(incident.map((item) => item.text), ['INFO request received', 'ERROR failed', '  at /app/main.ts:2', 'INFO request finished'])
})
