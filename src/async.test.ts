import { assert, test } from 'orca/testing'
import { createLimiter } from './async'

test('bounds parallel work and releases slots after failures and cancellation', async () => {
  const limited = createLimiter(2)
  let active = 0, peak = 0, started = 0
  const controllers = Array.from({ length: 12 }, () => new AbortController())
  const tasks = controllers.map((controller, i) => limited(async () => {
    started++; active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active--
    if (i === 0) throw new Error('expected failure')
    return i
  }, controller.signal))
  controllers[11].abort()
  const results = await Promise.allSettled(tasks)
  assert.equal(peak, 2)
  assert.equal(started, 11)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2)
  assert.equal(await limited(async () => 'still available'), 'still available')
})
