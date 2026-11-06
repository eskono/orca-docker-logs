import { assert, test } from 'orca/testing'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import type { FocusContext, LogAnswer, LogLine, ServiceRow, Workspace } from '../src/protocol'

const root = new URL('../', import.meta.url)
const html = await readFile(new URL('panel/index.html', root), 'utf8')
const bundle = await build({ entryPoints: [new URL('panel/main.ts', root).pathname], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const script = bundle.outputFiles[0].text
const A: Workspace = { id: 'A', name: 'A', path: '/project/A', branch: 'main' }
const B: Workspace = { id: 'B', name: 'B', path: '/project/B', branch: 'main' }
const context = (workspace: Workspace): FocusContext => ({ displayName: workspace.name, branch: 'main', terminals: [] })
const row = (path: string, extra: Partial<ServiceRow> = {}): ServiceRow => ({
  key: path === A.path ? 'a'.repeat(64) : 'b'.repeat(64),
  containerId: path === A.path ? 'a'.repeat(64) : 'b'.repeat(64),
  name: path === A.path ? 'A-app-1' : 'B-app-1', service: 'app', state: 'exited', exitCode: 0,
  oomKilled: false, restartCount: 0, stateError: '', health: '', healthLog: '', startedAt: null, finishedAt: null,
  ports: [], portBindings: [], profiles: [], build: false, ...extra
})
const line = (message: string, n = 1, path = A.path): LogLine => ({ t: `2026-01-01T00:00:0${n}.000000001Z`, m: message, e: false, containerId: row(path).containerId! })
const answer = (lines: LogLine[], extra: Partial<LogAnswer> = {}): LogAnswer => ({ lines, clearedAt: null, truncated: false, errors: [], limits: [], ...extra })
function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await new Promise<void>((done) => setImmediate(done)) }
type Override = (name: string, input: any) => unknown
async function panel(override: Override = () => undefined) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plugin.test/' })
  const { window } = dom
  const intervals: { ms: number; run: () => void }[] = []
  window.setInterval = ((callback: () => void, ms: number) => { intervals.push({ ms, run: callback }); return intervals.length }) as typeof window.setInterval
  const requests: { name: string; input: any }[] = []
  const copied: string[] = []
  const preferences: unknown[] = []
  Object.defineProperty(window.navigator, 'clipboard', { value: { async writeText(text: string) { copied.push(text) } } })
  let focus!: (payload: { context: FocusContext }) => void
  const orca = {
    on(_name: string, handler: typeof focus) { focus = handler },
    storage: { async get() { return null }, async set(_key: string, value: unknown) { preferences.push(value) } },
    shell: { async openExternal() { return { opened: true } } },
    files: { async saveAs() { return { status: 'saved' } } },
    plugin: {
      async request(name: string, input: any) {
        const payload = structuredClone(input)
        requests.push({ name, input: payload })
        const result = override(name, payload)
        if (result !== undefined) return result
        switch (name) {
          case 'workspaces.list': return { workspaces: [A, B], focused: input.context?.displayName === 'B' ? B : A }
          case 'compose.get': return { options: { files: [], profiles: [] } }
          case 'services.list': return { project: input.path, rows: [row(input.path)], options: { files: [], profiles: [] }, profiles: ['web'], context: { name: 'default', endpoint: 'unix:///var/run/docker.sock', remote: false } }
          case 'stats.get': return { stats: {} }
          case 'logs.get': return answer([line(`INFO ${input.path}`, 1, input.path)])
          case 'agent.ask': return { terminalId: 'agent-1', agent: 'claude', linesSent: input.lines.length }
          case 'code.resolve': return { files: {} }
          default: throw new Error(`Unexpected panel request: ${name}`)
        }
      }
    }
  }
  Object.assign(window, { orca })
  window.eval(script)
  await settle()
  return {
    dom, window, requests, copied, preferences, intervals,
    element<T extends HTMLElement>(id: string) { return window.document.getElementById(id) as T },
    focus(workspace: Workspace) { focus({ context: context(workspace) }) },
    poll(ms = 2000) { intervals.find((timer) => timer.ms === ms)!.run() }
  }
}

test('panel ignores out-of-order workspace focus responses', async (t) => {
  const pending = [deferred(), deferred()]
  let at = 0
  const ui = await panel((name) => name === 'workspaces.list' ? pending[at++].promise : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); ui.focus(B)
  pending[1].resolve({ workspaces: [A, B], focused: B })
  await settle()
  pending[0].resolve({ workspaces: [A, B], focused: A })
  await settle()
  assert.equal(ui.element<HTMLSelectElement>('workspace').value, B.path)
  assert.match(ui.element('log-title').textContent!, /B-app-1/)
})

test('panel invalidates old services across A → B → A navigation', async (t) => {
  const pending: ReturnType<typeof deferred>[] = []
  const ui = await panel((name) => {
    if (name === 'services.list') { const next = deferred(); pending.push(next); return next.promise }
  })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  ui.focus(B); await settle()
  ui.focus(A); await settle()
  const service = (name: string, path: string) => ({ project: name, rows: [row(path, { name })], options: { files: [], profiles: [] }, profiles: [], context: { name: 'default', endpoint: '', remote: false } })
  pending[2].resolve(service('fresh-A', A.path)); await settle()
  pending[1].resolve(service('old-B', B.path)); pending[0].resolve(service('old-A', A.path)); await settle()
  assert.equal(ui.element<HTMLSelectElement>('workspace').value, A.path)
  assert.match(ui.element('log-title').textContent!, /fresh-A/)
})

test('Clear cannot be undone by a delayed log poll', async (t) => {
  const pending: ReturnType<typeof deferred>[] = []
  const mark = '2026-01-01T01:00:00.000Z'
  const ui = await panel((name) => {
    if (name === 'logs.get') { const next = deferred(); pending.push(next); return next.promise }
    if (name === 'logs.clear') return { clearedAt: mark }
  })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  ui.element<HTMLButtonElement>('clear').click(); await settle()
  assert.equal(pending.length, 2)
  pending[1].resolve(answer([], { clearedAt: mark })); await settle()
  pending[0].resolve(answer([line('old line before Clear')])); await settle()
  assert.doesNotMatch(ui.element('log').textContent!, /old line/)
  assert.equal(ui.element('cleared').hidden, false)
})

test('incremental polling preserves existing DOM nodes and selected text, and Copy copies the selection', async (t) => {
  let polls = 0
  const ui = await panel((name) => name === 'logs.get' ? answer(++polls === 1 ? [line('INFO one')] : [line('INFO one'), line('INFO two', 2)]) : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  const original = ui.element('log').querySelector('.line')!
  const range = ui.window.document.createRange()
  range.selectNodeContents(original)
  ui.window.getSelection()!.addRange(range)
  ui.poll(); await settle()
  assert.equal(ui.element('log').querySelector('.line'), original)
  assert.equal(ui.window.getSelection()!.toString(), 'INFO one')
  const requests = ui.requests.filter((request) => request.name === 'logs.get')
  assert.equal(requests.at(-1)!.input.targets[0].cursor, line('').t)
  ui.element<HTMLButtonElement>('copy').click(); await settle()
  assert.equal(ui.copied.at(-1), 'INFO one')
})

test('JSON fields, correlation filters, grouped error counts and agent context work together', async (t) => {
  const json = '{"level":"error","trace_id":"trace-123","msg":"failed"}'
  const ui = await panel((name) => name === 'logs.get' ? answer([line('INFO request received'), line(json, 2), line(json, 3)]) : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  for (const id of ['group-errors', 'json-fields']) {
    const checkbox = ui.element<HTMLInputElement>(id)
    checkbox.checked = true; checkbox.dispatchEvent(new ui.window.Event('change'))
  }
  assert.equal(ui.element('log').querySelector('.repeat-count')?.textContent, '×2 ')
  const trace = [...ui.element('log').querySelectorAll('button')].find((button) => button.textContent === 'trace-123')!
  trace.click()
  assert.equal(ui.element<HTMLInputElement>('filter').value, 'trace_id="trace-123"')
  assert.doesNotMatch(ui.element('log').textContent!, /INFO request received/)
  ui.element<HTMLButtonElement>('ask').click(); await settle()
  const handoff = ui.requests.find((request) => request.name === 'agent.ask')!
  assert.match(handoff.input.lines.join('\n'), /INFO request received/)
  assert.deepEqual(handoff.input.containerIds, [row(A.path).containerId])
})

test('partial-source failures and truncation remain visible while filtering errors', async (t) => {
  const ui = await panel((name) => name === 'logs.get' ? answer([line('ERROR failure')], {
    truncated: true, limits: ['tail'], errors: [{ name: 'db', containerId: 'b', message: 'removed during rebuild' }]
  }) : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  const level = ui.element<HTMLSelectElement>('level')
  level.value = 'error'; level.dispatchEvent(new ui.window.Event('change'))
  assert.match(ui.element('log').textContent!, /Partial history/)
  assert.match(ui.element('log').textContent!, /db: removed during rebuild/)
})

test('Compose settings submit files/profiles and service-list height is keyboard accessible', async (t) => {
  let options = { files: [] as string[], profiles: [] as string[] }
  const ui = await panel((name, input) => {
    if (name === 'compose.get') return { options }
    if (name === 'compose.set') { options = input.options; return { options } }
  })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  ui.element<HTMLTextAreaElement>('compose-files').value = 'infra/stack.yml\ninfra/dev.yml'
  ui.element<HTMLInputElement>('compose-profiles').value = 'web, tools'
  ui.element<HTMLFormElement>('compose-form').dispatchEvent(new ui.window.Event('submit', { cancelable: true })); await settle()
  assert.deepEqual(options, { files: ['infra/stack.yml', 'infra/dev.yml'], profiles: ['web', 'tools'] })
  const splitter = ui.element('services-resize')
  splitter.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  assert.equal(ui.element('services').style.height, '48px')
  assert.equal((ui.preferences.at(-1) as { servicesHeight: number }).servicesHeight, 48)
})

test('diagnostics show OOM details and database ports copy addresses instead of opening HTTP', async (t) => {
  const ui = await panel((name, input) => name === 'services.list' ? {
    project: 'app', options: { files: [], profiles: [] }, profiles: [], context: { name: 'desktop-linux', endpoint: 'unix:///docker.sock', remote: false },
    rows: [row(input.path, { state: 'running', health: 'unhealthy', healthLog: 'connection refused', oomKilled: true, restartCount: 3, ports: [5433], portBindings: [{ host: '0.0.0.0', containerPort: 5432, port: 5433 }] })]
  } : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  assert.match(ui.element('diagnostic-body').textContent!, /OOM killed/)
  assert.match(ui.element('diagnostic-body').textContent!, /Restarts: 3/)
  assert.match(ui.element('docker-context').textContent!, /desktop-linux/)
  const port = ui.element('services').querySelector<HTMLButtonElement>('.port')!
  assert.equal(port.title, 'Copy localhost:5433')
  port.click(); await settle()
  assert.equal(ui.copied.at(-1), 'localhost:5433')
  assert.equal(ui.element('services').querySelectorAll('.port').length, 1)
})
