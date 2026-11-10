import { assert, test } from 'orca/testing'
import { validateViews } from './views'
import type { SavedView } from './protocol'
const view: SavedView = { id: 'errors', name: 'Errors', services: ['app', 'db', 'app'], filter: 'trace_id=123', search: 'failed', level: 'error', window: '15m', group: true, json: true, wrap: true, timestamps: true }
test('validates saved views, deduplicates services and preserves all-service selections', () => {
  assert.deepEqual(validateViews([view])[0].services, ['app', 'db'])
  assert.equal(validateViews([{ ...view, services: null }])[0].services, null)
  assert.throws(() => validateViews([view, view]), /Invalid saved view/)
  for (const patch of [{ services: ['--flag'] }, { window: 'event' }, { filter: 'x'.repeat(513) }, { name: '' }, { level: 'debug' }, { group: 'yes' }]) assert.throws(() => validateViews([{ ...view, ...patch }]))
  assert.throws(() => validateViews(Array.from({ length: 21 }, (_, i) => ({ ...view, id: String(i) }))))
})
