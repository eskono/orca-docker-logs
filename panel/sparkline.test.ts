import { assert, test } from 'orca/testing'
import { parseBytes, parsePercent, sparkPoints } from './sparkline'

test('reads docker stats numbers', () => {
  assert.equal(parsePercent('3.34%'), 3.34)
  assert.equal(parsePercent('--'), null)
  assert.equal(parseBytes('323.5MiB'), 323.5 * 1024 ** 2)
  assert.equal(parseBytes('1.5GiB'), 1.5 * 1024 ** 3)
  assert.equal(parseBytes('10MB'), 10e6)
  assert.equal(parseBytes('0B'), 0)
  assert.equal(parseBytes('lots'), null)
})

test('places the newest sample at the right edge, scaled to the box', () => {
  assert.equal(sparkPoints([0, 10], 3, 20, 11, 10), '10.0,10.5 20.0,0.5')
  assert.equal(sparkPoints([5, 50], 2, 10, 11, 10), '0.0,5.5 10.0,0.5') // above max is clipped
})
