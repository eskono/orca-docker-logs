import { assert, test } from 'orca/testing'
import { parseAnsi, stripAnsi } from './ansi'

test('plain text is one unstyled segment', () => {
  assert.deepEqual(parseAnsi('hello'), [{ text: 'hello', style: {} }])
  assert.deepEqual(parseAnsi(''), [])
})

test('reads colours, bold and resets', () => {
  assert.deepEqual(parseAnsi('\u001b[1;31mERR\u001b[0m ok \u001b[92mgreen\u001b[39m'), [
    { text: 'ERR', style: { bold: true, fg: 1 } },
    { text: ' ok ', style: {} },
    { text: 'green', style: { fg: 10 } }
  ])
})

test('reads 256-colour and true-colour codes', () => {
  assert.deepEqual(parseAnsi('\u001b[38;5;196ma\u001b[48;2;1;2;3mb'), [
    { text: 'a', style: { fg: 'rgb(255,0,0)' } },
    { text: 'b', style: { fg: 'rgb(255,0,0)', bg: 'rgb(1,2,3)' } }
  ])
  assert.deepEqual(parseAnsi('\u001b[38;5;3mx')[0].style, { fg: 3 })
})

test('drops other escape sequences and redrawn text', () => {
  assert.equal(stripAnsi('\u001b[2K\u001b[1Gdone \u001b]0;title\u0007!'), 'done !')
  assert.equal(stripAnsi('10%\r50%\r100%'), '100%')
  assert.equal(stripAnsi('line\r'), 'line')
})
