import { assert, test } from 'orca/testing'
import { buildRows, mergeLogs, newestWithin, parsePs, parseServices } from './docker'

const app = { ID: 'a'.repeat(64), Name: 'proj-app-1', Service: 'app', State: 'running', Status: 'Up 2 minutes (healthy)', Health: 'healthy' }
const db = { ID: 'b'.repeat(64), Name: 'proj-db-1', Service: 'db', State: 'exited', Status: 'Exited (1) 5 seconds ago', Health: '' }

test('reads compose ps as a JSON array (Compose < 2.21) and as JSON lines', () => {
  assert.deepEqual(parsePs(JSON.stringify([app, db])), [app, db])
  assert.deepEqual(parsePs(`${JSON.stringify(app)}\n${JSON.stringify(db)}\n`), [app, db])
  assert.deepEqual(parsePs('  \n'), [])
})

test('lists services in compose order, with placeholders and orphan containers', () => {
  const orphan = { ...app, ID: 'c'.repeat(64), Name: 'proj-old-1', Service: 'old' }
  const rows = buildRows(parseServices('db\napp\nworker\n'), [app, db, orphan])
  assert.deepEqual(
    rows.map((r) => [r.key, r.service, r.state]),
    [
      [db.ID, 'db', 'exited'],
      [app.ID, 'app', 'running'],
      ['service:worker', 'worker', 'not created'],
      [orphan.ID, 'old', 'running']
    ]
  )
  assert.equal(rows[2].containerId, null)
  assert.equal(rows[1].health, 'healthy')
})

test('interleaves stdout and stderr by timestamp and keeps message text as is', () => {
  const out = '2026-01-01T00:00:01.000000000Z first\n2026-01-01T00:00:03.000000000Z third  \n'
  const err = '2026-01-01T00:00:02.000000000Z \u001b[31msecond\u001b[0m\n'
  assert.deepEqual(mergeLogs(out, err), [
    { t: '2026-01-01T00:00:01.000000000Z', e: false, m: 'first' },
    { t: '2026-01-01T00:00:02.000000000Z', e: true, m: '\u001b[31msecond\u001b[0m' },
    { t: '2026-01-01T00:00:03.000000000Z', e: false, m: 'third  ' }
  ])
  assert.deepEqual(mergeLogs('', ''), [])
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
