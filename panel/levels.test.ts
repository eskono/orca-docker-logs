import { assert, test } from 'orca/testing'
import { levelOf, levels, levelToken } from './levels'

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

test('finds the level word to colour', () => {
  const at = (text: string) => {
    const token = levelToken(text)
    return token && [text.slice(token.start, token.end), token.tone]
  }
  assert.deepEqual(at('INFO:     127.0.0.1:52548 - "GET /api/health HTTP/1.1" 200 OK'), ['INFO', 'info'])
  assert.deepEqual(at('2026-11-05 07:31:17.867 UTC [35208] ERROR:  duplicate key'), ['ERROR', 'error'])
  assert.deepEqual(at('time="2026/10/20 07:44:50" level=error msg="[smtpd] 500"'), ['error', 'error'])
  assert.deepEqual(at('{"event": "outbox dispatched", "level": "info", "timestamp": "x"}'), ['info', 'info'])
  assert.deepEqual(at('{"level":"warn","msg":"HTTP/2 skipped"}'), ['warn', 'warn'])
  assert.deepEqual(at('DEBUG 2026 cache miss'), ['DEBUG', 'debug'])
  assert.equal(at('LOG:  checkpoint starting: time'), null)
  assert.equal(at('just some info about errors'), null)
})
