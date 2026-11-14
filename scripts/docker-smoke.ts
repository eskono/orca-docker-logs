// Opt-in integration check: only disposable, uniquely named containers; never pulls an image.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDocker, run } from '../src/docker'
import { timeKey } from '../src/log-time'
import { checkRootAndNestedEnv } from './compose-env-smoke'
import { hasComposeFile } from '../src/workspaces'
import { mockHost, mountWorker } from '../test/host'
import * as main from '../src/worker'
import type { LogLine, ServiceRow } from '../src/protocol'

const bin = await findDocker('')
const docker = (args: string[], cwd?: string) => run(bin, args, { cwd, timeoutMs: 45_000 })
await docker(['info', '--format', '{{.ServerVersion}}'])
await checkRootAndNestedEnv(bin)
const installed = (await docker(['image', 'ls', '--filter', 'dangling=false', '--format', '{{json .}}'])).stdout.trim().split('\n').filter(Boolean).map((value) => JSON.parse(value) as { Repository: string; Tag: string })
const requested = process.env.DOCKER_LOGS_TEST_IMAGE
const cached = installed.find((image) => /(?:^|\/)(alpine|busybox|python|node|debian|ubuntu|postgres|redis|nginx)$/.test(image.Repository) && image.Tag !== '<none>')
const image = requested || (cached ? `${cached.Repository}:${cached.Tag}` : null)
if (!image || image.startsWith('-') || !/^[\w./:@-]+$/.test(image)) throw new Error('No cached shell image found. Set DOCKER_LOGS_TEST_IMAGE to a cached Linux image with sh and sleep; this check never pulls images.')
await docker(['image', 'inspect', image])
const root = await realpath(await mkdtemp(join(tmpdir(), 'docker-logs-smoke-')))
const project = `orca-logs-smoke-${Date.now()}-${process.pid}`
const autoRoot = join(root, 'auto-workspace')
const autoProject = `${project}-auto`
let foreignId: string | null = null
let worker: Awaited<ReturnType<typeof mountWorker>> | null = null
try {
  await mkdir(join(root, 'infra'))
  await mkdir(join(root, 'code'))
  await writeFile(join(root, 'code', 'main.py'), 'print("smoke fixture")\n')
  await writeFile(join(root, '.env'), `COMPOSE_FILE=infra/stack.yml\nCOMPOSE_PROJECT_NAME=${project}\n`)
  const service = {
    image, pull_policy: 'never', entrypoint: ['/bin/sh', '-c'], command: ['i=0; while [ "$$i" -lt 120 ]; do echo "INFO tick $$i"; echo "ERROR fixture $$i" >&2; i=$$((i + 1)); sleep 1; done'],
    network_mode: 'none', read_only: true, cap_drop: ['ALL']
  }
  // JSON is a Compose-supported YAML subset. A nested file exercises project working_dir labels.
  await writeFile(join(root, 'infra', 'stack.yml'), JSON.stringify({ services: {
    app: { ...service, volumes: ['../code:/app:ro'] },
    db: service,
    tools: { ...service, profiles: ['tools'] },
    prod: { ...service, profiles: ['production'] }
  } }))
  assert.equal(await hasComposeFile(root), true)
  await docker(['compose', 'up', '-d', '--pull', 'never'], root)
  await mkdir(join(autoRoot, 'deploy'), { recursive: true })
  await writeFile(join(autoRoot, 'deploy', '.env.original'), `AUTO_IMAGE=${image}\nCOMPOSE_PROFILES=dev\n`)
  await writeFile(join(autoRoot, 'deploy', 'compose.yaml'), JSON.stringify({ services: {
    base: service,
    api: { ...service, image: '${AUTO_IMAGE:?original env file required}', profiles: ['dev', 'shared'], depends_on: ['base'] },
    idle: { ...service, profiles: ['jobs'] }
  } }))
  await docker(['compose', '--env-file', 'deploy/.env.original', '-f', 'deploy/compose.yaml', '-p', autoProject, '--profile', 'dev', 'up', '-d', '--pull', 'never', 'api'], autoRoot)
  let terminalOutput: string[] = []
  const host = mockHost({ settings: { dockerPath: bin }, results: {
    'terminal.create': async ({ command }: { command: string }) => {
      const result = await run('/bin/sh', ['-c', command], { cwd: root, timeoutMs: 45_000, env: { COMPOSE_FILE: 'missing.yml', COMPOSE_PROFILES: 'production', COMPOSE_PROJECT_NAME: 'wrong-project', COMPOSE_ENV_FILES: 'missing.env', COMPOSE_DISABLE_ENV_FILE: 'true', COMPOSE_REMOVE_ORPHANS: 'true' } })
      terminalOutput = (result.stdout + result.stderr).split('\n')
      return { terminalId: 'smoke-operation-terminal' }
    },
    'terminal.read': () => ({ lines: terminalOutput, truncated: false }),
    'workspace.list': { workspaces: [{ id: 'smoke', name: 'smoke', path: root, branch: 'main', hostId: 'local' }, { id: 'auto-smoke', name: 'auto-smoke', path: autoRoot, branch: 'main', hostId: 'local' }] }
  } })
  worker = await mountWorker(main, { host })
  const automatic = await worker.request('services.list', { path: autoRoot })
  assert.equal(automatic.detected, true)
  assert.equal(automatic.project, autoProject)
  assert.deepEqual(automatic.options.files, ['deploy/compose.yaml'])
  assert.deepEqual(automatic.runtime.runningProfiles.map((profile: { name: string }) => profile.name), ['dev', 'shared'])
  const autoApi = automatic.rows.find((row: ServiceRow) => row.service === 'api') as ServiceRow
  assert.equal(autoApi.state, 'running')
  assert.deepEqual((await worker.request('compose.get', { path: autoRoot })).options, { files: [], profiles: [] })
  const autoLogs = await worker.request('logs.get', { path: autoRoot, targets: [{ service: 'api', name: autoApi.name, containerId: autoApi.containerId }] })
  assert.ok(autoLogs.lines.some((line: LogLine) => line.m.startsWith('INFO tick')))
  await assert.rejects(worker.request('project.action', { path: autoRoot, action: 'down' }), { code: 'invalid_params' })
  assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', autoApi.containerId!])).stdout.trim(), 'true')
  await worker.request('compose.set', { path: autoRoot, options: { ...automatic.options, envFile: 'deploy/.env.original' } })
  assert.equal((await worker.request('services.list', { path: autoRoot, fresh: true })).detected, false)
  const discovered = await worker.request('compose.discover', { path: root })
  assert.ok(discovered.files.includes('infra/stack.yml'))
  const preview = await worker.request('compose.profiles', { path: root, files: ['infra/stack.yml'] })
  assert.deepEqual([...preview.profiles].sort(), ['production', 'tools'])
  assert.deepEqual(preview.runtime.effectiveProfiles, [])
  assert.deepEqual((await worker.request('compose.get', { path: root })).options, { files: [], profiles: [] })
  const model = await worker.request('services.list', { path: root })
  const app = model.rows.find((row: ServiceRow) => row.service === 'app') as ServiceRow
  const db = model.rows.find((row: ServiceRow) => row.service === 'db') as ServiceRow
  assert.equal(app.state, 'running')
  assert.equal(db.state, 'running')
  assert.equal(model.rows.find((row: ServiceRow) => row.service === 'tools').containerId, null)
  assert.equal(model.project, project)
  assert.notEqual(model.context.name, 'unknown')
  const targets = [app, db].map((row) => ({ service: row.service, name: row.name, containerId: row.containerId! }))
  const first = await worker.request('logs.get', { path: root, targets })
  assert.equal(first.errors.length, 0)
  assert.ok(first.lines.some((line: LogLine) => line.m.startsWith('ERROR fixture')))
  assert.ok(first.lines.some((line: LogLine) => line.e))
  const mapped = await worker.request('code.resolve', { path: root, service: 'app', files: ['/app/main.py'] })
  assert.equal(mapped.files['/app/main.py'], 'code/main.py')
  const stats = await worker.request('stats.get', { path: root, containerIds: [app.containerId, db.containerId] })
  assert.ok(stats.stats[app.containerId!])
  await worker.request('compose.set', { path: root, options: { files: ['infra/stack.yml'], profiles: ['tools'] } })
  await worker.request('events.list', { path: root })
  await worker.request('service.action', { path: root, service: app.service, containerId: app.containerId, action: 'restart' })
  const operations = await worker.request('operations.list', { path: root })
  assert.equal(operations.operations[0].status, 'succeeded')
  let events
  for (let i = 0; i < 15; i++) {
    events = await worker.request('events.list', { path: root })
    if (events.events.some((event: { action: string }) => event.action === 'restart')) break
    await new Promise((done) => setTimeout(done, 200))
  }
  assert.ok(events.events.some((event: { action: string; containerId: string }) => event.action === 'restart' && event.containerId === app.containerId))
  const restartAt = events.events.find((event: { action: string }) => event.action === 'restart').t
  const bounded = await worker.request('logs.get', { path: root, targets: [{ ...targets[0], since: new Date(Date.parse(restartAt) - 30_000).toISOString(), until: restartAt }] })
  assert.ok(bounded.lines.length > 0)
  assert.ok(bounded.lines.every((line: LogLine) => timeKey(line.t) <= timeKey(restartAt)))
  const view = { id: 'smoke-view', name: 'App and DB', services: ['app', 'db'], filter: '', search: 'fixture', level: 'error', window: '5m', group: true, json: false, wrap: true, timestamps: true }
  await worker.request('views.set', { path: root, views: [view] })
  assert.deepEqual((await worker.request('views.get', { path: root })).views, [view])
  const { clearedAt } = await worker.request('logs.clear', { path: root, services: ['app', 'db'] })
  await new Promise((done) => setTimeout(done, 1200))
  const cleared = await worker.request('logs.get', { path: root, targets })
  assert.equal(cleared.errors.length, 0)
  assert.ok(cleared.lines.length > 0)
  assert.ok(cleared.lines.every((line: LogLine) => timeKey(line.t) >= timeKey(clearedAt)))
  const cursor = cleared.lines.filter((line: LogLine) => line.containerId === app.containerId).at(-1).t
  const increment = await worker.request('logs.get', { path: root, targets: [{ ...targets[0], cursor }] })
  assert.ok(increment.lines.every((line: LogLine) => timeKey(line.t) >= timeKey(cursor)))
  await worker.request('logs.clear', { path: root, services: ['app', 'db'], reset: true })
  foreignId = (await docker(['run', '-d', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--name', `${project}-foreign`, '--entrypoint', '/bin/sh', image, '-c', 'sleep 120'])).stdout.trim()
  await assert.rejects(worker.request('service.action', { path: root, service: 'app', containerId: foreignId, action: 'stop' }), { code: 'not_permitted' })
  assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', foreignId])).stdout.trim(), 'true')
  await writeFile(join(root, '.env'), `COMPOSE_FILE=infra/stack.yml\nCOMPOSE_PROJECT_NAME=${project}\nSTAGE=tools\nCOMPOSE_PROFILES="\${STAGE}"\nPRIVATE_VALUE=not-for-the-panel\n`)
  await worker.request('compose.set', { path: root, options: { files: [], profiles: [] } })
  const inherited = await worker.request('services.list', { path: root, fresh: true })
  assert.deepEqual(inherited.runtime.environmentProfiles, ['tools'])
  assert.deepEqual(inherited.runtime.effectiveProfiles, ['tools'])
  assert.equal(JSON.stringify(inherited).includes('not-for-the-panel'), false)
  await worker.request('project.action', { path: root, action: 'up' })
  assert.equal((await worker.request('operations.list', { path: root })).operations[0].status, 'succeeded')
  const tools = (await worker.request('services.list', { path: root, fresh: true })).rows.find((row: ServiceRow) => row.service === 'tools') as ServiceRow
  assert.equal(tools.state, 'running')
  await writeFile(join(root, 'infra', '.env.production'), `COMPOSE_PROJECT_NAME=${project}\nCOMPOSE_PROFILES=production\nPRIVATE_VALUE=still-not-for-the-panel\n`)
  await worker.request('compose.set', { path: root, options: { files: ['infra/stack.yml'], envFile: 'infra/.env.production', profiles: [] } })
  const production = await worker.request('services.list', { path: root, fresh: true })
  assert.deepEqual(production.runtime.effectiveProfiles, ['production'])
  assert.deepEqual(production.runtime.outsideSelection, ['tools'])
  assert.equal(JSON.stringify(production).includes('still-not-for-the-panel'), false)
  await worker.request('project.action', { path: root, action: 'restart' })
  const toolsAfterRestart = (await worker.request('services.list', { path: root, fresh: true })).rows.find((row: ServiceRow) => row.service === 'tools') as ServiceRow
  assert.equal(toolsAfterRestart.startedAt, tools.startedAt)
  await worker.request('compose.set', { path: root, options: { files: ['infra/stack.yml'], envFile: 'infra/.env.production', profileMode: 'manual', profiles: [] } })
  const base = await worker.request('services.list', { path: root, fresh: true })
  assert.deepEqual(base.runtime.environmentProfiles, ['production'])
  assert.deepEqual(base.runtime.effectiveProfiles, [])
  assert.deepEqual(base.runtime.enabledServices.sort(), ['app', 'db'])
  await worker.request('project.action', { path: root, action: 'down' })
  assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', tools.containerId!])).stdout.trim(), 'true')
  console.log('Live Docker smoke passed: automatic nested-stack/container/profile matching and logs, explicit adoption, root/nested dotenv compatibility, profile inheritance and overrides, scoped project commands, terminal environment isolation, ownership, stdout/stderr logs, Clear, cursors, stats, bind-mount source mapping, operation completion, event streaming, bounded event logs, saved views and restart.')
} catch (error) {
  const logs = await docker(['compose', '-p', project, '-f', 'infra/stack.yml', 'logs', '--no-color', '--tail', '10'], root).catch(() => null)
  if (logs) console.error(logs.stdout + logs.stderr)
  throw error
} finally {
  await worker?.deactivate()
  let cleanupFailed = false
  if (foreignId) await docker(['rm', '-f', foreignId]).catch((error) => { cleanupFailed = true; console.error(error) })
  await docker(['compose', '--env-file', 'auto-workspace/deploy/.env.original', '-p', autoProject, '-f', 'auto-workspace/deploy/compose.yaml', '--profile', '*', 'down', '--remove-orphans'], root).catch((error) => { cleanupFailed = true; console.error(error) })
  await docker(['compose', '-p', project, '-f', 'infra/stack.yml', '--profile', '*', 'down', '--remove-orphans'], root).catch((error) => { cleanupFailed = true; console.error(error) })
  if (!cleanupFailed) await rm(root, { recursive: true, force: true })
  else { console.error(`Cleanup needs attention: project ${project}, files ${root}`); process.exitCode = 1 }
}
