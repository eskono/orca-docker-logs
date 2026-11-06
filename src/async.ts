/** A process budget shared by all Docker requests, including concurrent panel and status polls. */
export function createLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit')
  let active = 0
  const queue: (() => void)[] = []
  return async function limited<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => { active++; resolve() }
      if (active < limit) start()
      else queue.push(start)
    })
    try {
      signal?.throwIfAborted()
      return await work()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}
