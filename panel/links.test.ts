import { assert, test } from 'orca/testing'
import { findLinks } from './links'

const pick = (text: string) => findLinks(text).map((l) => [text.slice(l.start, l.end), l.kind === 'url' ? l.url : `${l.file}:${l.line}${l.kind === 'file' && l.column ? `:${l.column}` : ''}`])

test('finds web addresses, trimming punctuation and naming 0.0.0.0 localhost', () => {
  assert.deepEqual(pick('Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)'), [['http://0.0.0.0:8000', 'http://localhost:8000']])
  assert.deepEqual(pick('see https://docs.example.com/a?b=1.'), [['https://docs.example.com/a?b=1', 'https://docs.example.com/a?b=1']])
  assert.deepEqual(pick('nothing here: /healthz 200'), [])
})

test('finds source locations in Python, Node, Go, Ruby and PHP traces', () => {
  assert.deepEqual(pick('  File "/srv/app/core/media.py", line 42, in probe'), [['/srv/app/core/media.py', '/srv/app/core/media.py:42']])
  assert.deepEqual(pick('    at handler (/app/src/routes/cart.ts:17:9)'), [['/app/src/routes/cart.ts:17:9', '/app/src/routes/cart.ts:17:9']])
  assert.deepEqual(pick('\t/go/src/app/main.go:88 +0x1d'), [['/go/src/app/main.go:88', '/go/src/app/main.go:88']])
  assert.deepEqual(pick("/app/app/models/user.rb:12:in 'save'"), [['/app/app/models/user.rb:12', '/app/app/models/user.rb:12']])
  assert.deepEqual(pick('Fatal error: boom in /var/www/html/index.php on line 7'), [['/var/www/html/index.php', '/var/www/html/index.php:7']])
})

test('does not take a path inside a URL, or paths without a line, for a source location', () => {
  assert.deepEqual(pick('GET http://localhost:5173/src/main.tsx:3 failed'), [['http://localhost:5173/src/main.tsx:3', 'http://localhost:5173/src/main.tsx:3']])
  assert.deepEqual(pick('connection to /var/run/postgresql:5432 failed'), [])
  assert.deepEqual(pick('2026/10/20 07:44:50 started'), [])
})
