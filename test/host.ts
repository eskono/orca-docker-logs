// Portable worker fixture for `npm test`. `orca plugin test` uses Orca's real testing kit instead.
export { default as assert } from 'node:assert/strict'
export { test } from 'node:test'
import type { OrcaWorkerApi } from '../types/worker'

type Options = { settings?: Record<string, unknown>; results?: Record<string, unknown> }
export function mockHost(options: Options = {}) {
  const calls: { method: string; params: unknown }[] = []
  const data = new Map<string, unknown>()
  return {
    options, data,
    callsOf(method: string): unknown[] { return calls.filter((c) => c.method === method).map((c) => c.params) },
    async call(method: string, params: unknown): Promise<unknown> {
      calls.push({ method, params })
      const result = options.results?.[method]
      if (typeof result === 'function') return result(params)
      if (result !== undefined) return structuredClone(result)
      throw new Error(`Unconfigured host call: ${method}`)
    }
  }
}

export async function mountWorker(module: { default: (api: OrcaWorkerApi) => void; deactivate: () => void | Promise<void> }, { host }: { host: ReturnType<typeof mockHost> }) {
  const handlers = new Map<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>>()
  const events = new Map<string, (payload: unknown) => unknown>()
  const api: OrcaWorkerApi = {
    host,
    panels: { handle(name, handler) { handlers.set(name, handler) } },
    settings: { async get(key) { return host.options.settings?.[key] ?? null } },
    storage: {
      async get(key) { return host.data.get(key) ?? null },
      async set(key, value) { host.data.set(key, value) },
      async delete(key) { host.data.delete(key) }
    },
    events: { on(name, handler) { events.set(name, handler as (payload: unknown) => unknown) } },
    log() {}
  }
  module.default(api)
  return {
    // The host kit intentionally accepts malformed requests to test the runtime validation boundary.
    async request(name: string, input: unknown): Promise<any> {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`No handler: ${name}`)
      return handler(input, { signal: new AbortController().signal })
    },
    async emit(name: string, payload: unknown) { await events.get(name)?.(payload) },
    async deactivate() { await module.deactivate(); handlers.clear(); events.clear() }
  }
}
