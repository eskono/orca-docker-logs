// The small Orca worker API surface this plugin consumes. No runtime implementation.
// Keep this contract explicit while Orca's packaged typings are unavailable.
import type { FocusContext } from '../src/protocol'

export type OrcaWorkerApi = {
  host: { call(method: string, params: unknown): Promise<unknown> }
  panels: { handle(name: string, handler: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>): void }
  settings: { get(key: string): Promise<unknown> }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  events: { on(name: 'workspace.changed', handler: (payload: { context: FocusContext }) => unknown): unknown }
  log(message: string): void
}
