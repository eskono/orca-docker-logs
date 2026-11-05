import { assert, test } from 'orca/testing'
import { localOnly, normalizeBranch, resolveFocused } from './workspaces'

const ws = (id: string, name: string, path: string, branch: string | null) => ({ id, name, path, branch })
const all = [
  ws('1', 'main', '/repos/api', 'main'),
  ws('2', 'main', '/repos/web', 'main'),
  ws('3', 'feature-x', '/repos/api-feature', 'feature-x'),
  ws('4', 'notes', '/notes', null)
]
const noTerminals = async () => {
  throw new Error('should not be asked')
}

test('normalizes branches the way the two APIs report them', () => {
  assert.equal(normalizeBranch('refs/heads/main'), 'main')
  assert.equal(normalizeBranch(''), null)
  assert.equal(normalizeBranch(null), null)
})

test('keeps only workspaces on this machine', () => {
  const listed = [{ ...all[0], hostId: 'local' }, { ...all[1], hostId: null }, { ...all[2], hostId: 'ssh:box' }]
  assert.deepEqual(localOnly(listed).map((w) => w.id), ['1', '2'])
})

test('a unique name and branch is enough', async () => {
  const context = { displayName: 'feature-x', branch: 'refs/heads/feature-x', terminals: [] }
  assert.equal((await resolveFocused(context, all, noTerminals))?.path, '/repos/api-feature')
  const folder = { displayName: 'notes', branch: '', terminals: [] }
  assert.equal((await resolveFocused(folder, all, noTerminals))?.path, '/notes')
  assert.equal(await resolveFocused(null, all, noTerminals), null)
  assert.equal(await resolveFocused({ displayName: 'gone', branch: 'x', terminals: [] }, all, noTerminals), null)
})

test('the focused terminals tell apart workspaces sharing a name and branch', async () => {
  const terminals = async () => new Map([['term_a', '/repos/api'], ['term_b', '/repos/web']])
  const context = { displayName: 'main', branch: 'main', terminals: [{ id: 'term_x' }, { id: 'term_b' }] }
  assert.equal((await resolveFocused(context, all, terminals))?.path, '/repos/web')
  assert.equal(await resolveFocused({ ...context, terminals: [] }, all, noTerminals), null)
  assert.equal(await resolveFocused({ ...context, terminals: [{ id: 'term_x' }] }, all, terminals), null)
})
