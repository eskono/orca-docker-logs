// Portable source/manifest integrity checks. Also run `orca plugin validate .` before releasing.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'))
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(manifest.manifestVersion, 2)
assert.equal(manifest.execution, 'trusted-worker')
assert.equal(manifest.version, pkg.version)
assert.match(manifest.id, /^[a-z][a-z0-9-]*$/)
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
const panels = manifest.contributes.panels
assert.ok(panels.length > 0)
assert.equal(new Set(panels.map((panel) => panel.id)).size, panels.length)
const settings = manifest.contributes.settings
assert.equal(new Set(settings.map((setting) => setting.key)).size, settings.length)
for (const file of [manifest.main, manifest.icon, manifest.cover.path, ...manifest.screenshots.map((shot) => shot.path), ...panels.map((panel) => panel.entry)]) {
  const rel = relative(root, resolve(root, file))
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `Invalid manifest path: ${file}`)
  assert.ok((await stat(resolve(root, file))).isFile(), `Missing manifest file: ${file}`)
}
await build({ entryPoints: ['panel/main.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' })
await build({ entryPoints: [manifest.main], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
console.log('Manifest assets, version and browser/worker imports are valid.')
