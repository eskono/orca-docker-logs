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
          case 'operations.list': return { operations: [] }
          case 'events.list': return { events: [], connected: true, error: null, startedAt: new Date().toISOString(), limited: false }
          case 'views.get': return { views: [] }
          case 'views.set': return { views: input.views }
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

test('search preserves context, navigates collapsed traces and keeps full text for Copy', async (t) => {
  const trace = ['INFO before', 'TypeError: failed', '  at library (/app/node_modules/lib/index.js:1:2)', '  at handler (/app/src/main.ts:4:2)', 'INFO after']
  const ui = await panel((name) => {
    if (name === 'logs.get') return answer(trace.map((m, i) => line(m, i)))
    if (name === 'code.resolve') return { files: { '/app/src/main.ts': 'src/main.ts' } }
  })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  const details = ui.element('log').querySelector<HTMLDetailsElement>('.trace')!
  assert.equal(details.open, false)
  assert.equal(details.querySelectorAll('.trace-project').length, 1)
  assert.equal(details.querySelectorAll('.trace-library').length, 1)
  const search = ui.element<HTMLInputElement>('search')
  search.value = 'handler'; search.dispatchEvent(new ui.window.Event('input'))
  assert.match(ui.element('search-count').textContent!, /1 \/ 1/)
  assert.match(ui.element('log').textContent!, /INFO before/)
  assert.match(ui.element('log').textContent!, /INFO after/)
  ui.element<HTMLButtonElement>('search-next').click()
  assert.equal(ui.element('log').querySelector<HTMLDetailsElement>('.trace')!.open, true)
  ui.element<HTMLButtonElement>('copy').click(); await settle()
  assert.match(ui.copied.at(-1)!, /library.*\n.*handler/)
  assert.doesNotMatch(ui.copied.at(-1)!, /stack frames/)
  ui.element<HTMLButtonElement>('error-next').click()
  assert.equal(ui.element('log').querySelectorAll('.current-error').length, 1)
})

test('operation output and terminal access remain visible while a command runs', async (t) => {
  const ui = await panel((name) => name === 'operations.list' ? { operations: [{ id: 'build-1', title: 'Build app', service: 'app', terminalId: 'terminal-1', status: 'running', startedAt: '2026-01-01T00:00:00Z', finishedAt: null, exitCode: null, lines: ['[2/4] compiling'] }] } : name === 'operations.open' ? { opened: true } : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  assert.equal(ui.element<HTMLDetailsElement>('operations').open, true)
  assert.match(ui.element('operations-list').textContent!, /compiling/)
  assert.equal(ui.element<HTMLButtonElement>('project-up').disabled, true)
  ui.element('operations-list').querySelector<HTMLButtonElement>('button')!.click(); await settle()
  assert.deepEqual(ui.requests.find((request) => request.name === 'operations.open')!.input, { path: A.path, id: 'build-1' })
})

test('event navigation reads a bounded log period, pauses follow and retains removed-container history', async (t) => {
  const event = { id: 'evt', t: '2026-01-01T00:00:03.123456789Z', containerId: row(A.path).containerId, name: 'A-app-1', service: 'app', action: 'oom', detail: '' }
  const ui = await panel((name) => name === 'events.list' ? { events: [event, { ...event, id: 'removed', containerId: 'c'.repeat(64), action: 'destroy' }], connected: true, error: null, startedAt: event.t, limited: false } : undefined)
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  ui.element('events-list').querySelector<HTMLButtonElement>('button')!.click(); await settle()
  const target = ui.requests.filter((request) => request.name === 'logs.get').at(-1)!.input.targets[0]
  assert.equal(target.since, '2025-12-31T23:59:33.123Z')
  assert.equal(target.until, '2026-01-01T00:00:33.123Z')
  assert.equal(ui.element<HTMLInputElement>('follow').checked, false)
  assert.equal(ui.element<HTMLSelectElement>('window').value, 'event')
  ui.element('events-list').querySelectorAll<HTMLButtonElement>('button')[1].click()
  assert.match(ui.element('notice').textContent!, /removed/)
  ui.element<HTMLButtonElement>('live').click(); await settle()
  assert.equal(ui.element<HTMLInputElement>('follow').checked, true)
  assert.equal(ui.element<HTMLSelectElement>('window').value, 'tail')
  assert.equal(ui.requests.filter((request) => request.name === 'logs.get').at(-1)!.input.targets[0].until, undefined)
})

test('combines selected services and restores a saved view only in its project', async (t) => {
  const data = new Map<string, any[]>()
  const ui = await panel((name, input) => {
    if (name === 'services.list') return { project: input.path, rows: [row(input.path), row(input.path, { key: 'c'.repeat(64), containerId: 'c'.repeat(64), name: 'db-1', service: 'db' })], options: { files: [], profiles: [] }, profiles: [], context: { name: 'default', endpoint: '', remote: false } }
    if (name === 'views.get') return { views: data.get(input.path) ?? [] }
    if (name === 'views.set') { data.set(input.path, structuredClone(input.views)); return { views: input.views } }
  })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle()
  const db = ui.element('services').querySelector<HTMLInputElement>('[aria-label="Include db in combined logs"]')!
  db.checked = true; db.dispatchEvent(new ui.window.Event('change')); await settle()
  assert.deepEqual(ui.requests.filter((request) => request.name === 'logs.get').at(-1)!.input.targets.map((target: any) => target.service), ['app', 'db'])
  const filter = ui.element<HTMLInputElement>('filter'); filter.value = 'ERROR'; filter.dispatchEvent(new ui.window.Event('input'))
  const level = ui.element<HTMLSelectElement>('level'); level.value = 'error'; level.dispatchEvent(new ui.window.Event('change'))
  const viewName = ui.element<HTMLInputElement>('view-name'); viewName.value = 'API + DB'; viewName.dispatchEvent(new ui.window.Event('input'))
  ui.element<HTMLButtonElement>('view-save').click(); await settle()
  assert.deepEqual(data.get(A.path)![0].services, ['app', 'db'])
  ui.focus(B); await settle()
  assert.equal(ui.element<HTMLSelectElement>('saved-view').options.length, 1)
  ui.focus(A); await settle()
  filter.value = ''; level.value = 'all'
  const select = ui.element<HTMLSelectElement>('saved-view'); select.value = data.get(A.path)![0].id; select.dispatchEvent(new ui.window.Event('change')); await settle()
  assert.equal(filter.value, 'ERROR')
  assert.equal(level.value, 'error')
  assert.deepEqual(ui.requests.filter((request) => request.name === 'logs.get').at(-1)!.input.targets.map((target: any) => target.service), ['app', 'db'])
  ui.element<HTMLButtonElement>('view-delete').click(); await settle()
  assert.equal(data.get(A.path)!.length, 0)
})

test('delayed saved-view responses cannot replace a newly selected workspace', async (t) => {
  const pending: ReturnType<typeof deferred>[] = []
  const ui = await panel((name) => { if (name === 'views.get') { const wait = deferred(); pending.push(wait); return wait.promise } })
  t.after(() => ui.dom.window.close())
  ui.focus(A); await settle(); ui.focus(B); await settle(); ui.focus(A); await settle()
  pending[2].resolve({ views: [] }); await settle()
  pending[0].resolve({ views: [{ id: 'old', name: 'Old view' }] }); pending[1].resolve({ views: [{ id: 'wrong', name: 'Other project' }] }); await settle()
  assert.equal(ui.element<HTMLSelectElement>('saved-view').options.length, 1)
  assert.equal(ui.element<HTMLSelectElement>('workspace').value, A.path)
})
