import { assert, test } from 'orca/testing'
import { levelOf, levels } from './levels'

test('finds error and warning lines in common formats', () => {
  for (const line of [
    'ERROR:root:payment failed',
    '2026-11-05 08:24:48 UTC [64] FATAL:  password authentication failed',
    'level=error msg="dial tcp: connection refused"',
    '{"level":"error","msg":"boom"}',
    '{"level":50,"msg":"pino error"}',
    '[error] worker crashed',
    'ValueError: invalid literal for int()',
    'java.lang.NullPointerException: null',
    'Traceback (most recent call last):'
  ]) {
    assert.equal(levelOf(line), 'error', line)
  }
  for (const line of ['WARNING:  there is no transaction in progress', 'level=warn msg=slow', '{"severity":"warning"}', '[warn] retry 2/5']) {
    assert.equal(levelOf(line), 'warn', line)
  }
  for (const line of ['INFO: no error found', 'GET /errors 200', 'ERROR_CODES loaded', 'warning-free build']) {
    assert.equal(levelOf(line), null, line)
  }
})

test('indented lines after an error share its level', () => {
  assert.deepEqual(
    levels([
      'INFO starting',
      'Traceback (most recent call last):',
      '  File "app.py", line 3, in <module>',
      '    main()',
      'RuntimeError: boom',
      'INFO next',
      '  indented but after info'
    ]),
    [null, 'error', 'error', 'error', 'error', null, null]
  )
})
