type Entry = { key: string; create: () => HTMLElement }
const caches = new WeakMap<HTMLElement, Map<string, HTMLElement>>()

/** Reuse unchanged line nodes so polling does not destroy text selection or keyboard focus. */
export function reconcileLog(parent: HTMLElement, entries: Entry[]): void {
  const previous = caches.get(parent) ?? new Map<string, HTMLElement>()
  const next = new Map<string, HTMLElement>()
  const occurrences = new Map<string, number>()
  let cursor = parent.firstChild
  for (const entry of entries) {
    const occurrence = occurrences.get(entry.key) ?? 0
    occurrences.set(entry.key, occurrence + 1)
    const key = `${occurrence}\0${entry.key}`
    const node = previous.get(key) ?? entry.create()
    next.set(key, node)
    if (node !== cursor) parent.insertBefore(node, cursor)
    else cursor = cursor.nextSibling
  }
  const kept = new Set(next.values())
  for (const node of [...parent.childNodes]) if (!kept.has(node as HTMLElement)) parent.removeChild(node)
  caches.set(parent, next)
}
