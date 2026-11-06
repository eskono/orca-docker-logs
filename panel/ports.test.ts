import { assert, test } from 'orca/testing'
import { portAddress } from './ports'
const local = { name: 'default', endpoint: 'unix:///var/run/docker.sock', remote: false }
test('database ports are copied as addresses and web ports use the published port and proper scheme', () => {
  assert.deepEqual(portAddress({ port: 5433, containerPort: 5432, host: '0.0.0.0' }, local), { address: 'localhost:5433', url: null })
  assert.deepEqual(portAddress({ port: 9443, containerPort: 443, host: '::' }, local), { address: 'localhost:9443', url: 'https://localhost:9443' })
  assert.deepEqual(portAddress({ port: 8000, containerPort: 80, host: '0.0.0.0' }, { name: 'remote', endpoint: 'ssh://user@example.com', remote: true }), { address: 'example.com:8000', url: 'http://example.com:8000' })
})
