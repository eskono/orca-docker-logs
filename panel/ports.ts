import type { DockerContext, PortBinding } from '../src/protocol'

const HTTP = new Set([80, 3000, 3001, 4200, 5000, 5173, 8000, 8001, 8080, 8081, 8888, 9000])
const HTTPS = new Set([443, 8443])
export function portAddress(binding: PortBinding, context: DockerContext): { address: string; url: string | null } {
  let host = binding.host
  if (context.remote) {
    try { host = new URL(context.endpoint).hostname } catch { host = '' }
  } else if (!host || ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(host)) host = 'localhost'
  if (!host) return { address: `:${binding.port}`, url: null }
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  const address = `${host}:${binding.port}`
  const scheme = HTTPS.has(binding.containerPort) ? 'https' : HTTP.has(binding.containerPort) ? 'http' : null
  return { address, url: scheme ? `${scheme}://${address}` : null }
}
