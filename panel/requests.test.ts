import { assert, test } from 'orca/testing'
import { RequestGate } from './requests'

test('ignores responses from an old project even after returning to the same path', () => {
  const lane = new RequestGate()
  const A = lane.begin()!
  lane.invalidate()
  const B = lane.begin()!
  lane.invalidate()
  const Aagain = lane.begin()!
  assert.equal(lane.current(A), false)
  assert.equal(lane.current(B), false)
  assert.equal(lane.current(Aagain), true)
  assert.equal(A.signal.aborted, true)
  lane.finish(A)
  assert.equal(lane.begin(), null)
  lane.finish(Aagain)
  assert.ok(lane.begin())
})

test('replacing an in-flight poll invalidates it and keeps the newer request locked', () => {
  const lane = new RequestGate()
  const beforeClear = lane.begin()!
  const afterClear = lane.begin(true)!
  lane.finish(beforeClear)
  assert.equal(lane.current(beforeClear), false)
  assert.equal(lane.current(afterClear), true)
  assert.equal(lane.begin(), null)
})
