import type { LogLine } from '../src/protocol'
import { stripAnsi } from './ansi'
import { levels, levelOf, type Level } from './levels'

export type Shown = { line: LogLine; text: string; level: Level; fields: Record<string, unknown> | null; count: number }
export function jsonFields(text: string): Record<string, unknown> | null {
  if (!text.trimStart().startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const flat: Record<string, unknown> = Object.create(null)
    let count = 0
    function walk(record: Record<string, unknown>, prefix = '', depth = 0): void {
      for (const [name, item] of Object.entries(record)) {
        if (++count > 100) return
        const key = prefix + name
        if (item && typeof item === 'object' && !Array.isArray(item) && depth < 4) walk(item as Record<string, unknown>, key + '.', depth + 1)
        else flat[key] = item
      }
    }
    walk(value as Record<string, unknown>)
    return flat
  } catch { return null }
}
export function analyze(lines: LogLine[]): Shown[] {
  const texts = lines.map((line) => stripAnsi(line.m))
  const detected = levels(texts, lines.map((line) => line.containerId ?? line.src ?? ''))
  return lines.map((line, i) => ({ line, text: texts[i], level: detected[i], fields: jsonFields(texts[i]), count: 1 }))
}
export function matchesFilter(item: Shown, query: string): boolean {
  const terms = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []
  return terms.every((term) => {
    const field = /^([\w.-]+)([=:])(.*)$/.exec(term)
    const unquote = (value: string) => value.replace(/^"|"$/g, '').toLowerCase()
    if (field && (field[2] === '=' || isCorrelation(field[1]) || Object.hasOwn(item.fields ?? {}, field[1]))) {
      const wanted = field[1].toLowerCase()
      const found = Object.entries(item.fields ?? {}).find(([key]) => key.toLowerCase() === wanted)
      return found ? String(found[1]).toLowerCase() === unquote(field[3]) : !item.fields && item.text.toLowerCase().includes(term.toLowerCase())
    }
    const text = unquote(term)
    return item.text.toLowerCase().includes(text) || (item.line.src ?? '').toLowerCase().includes(text)
  })
}
export const isCorrelation = (key: string) => /(?:^|\.)(?:request_?id|trace_?id|correlation_?id)$/i.test(key)

/** Collapse whole error records per container, preserving each representative stack trace. */
export function groupErrors(items: Shown[]): Shown[] {
  type Block = { at: number; items: Shown[] }
  const pending = new Map<string, Block>()
  const blocks: Block[] = []
  const flush = (source: string) => { const block = pending.get(source); if (block) blocks.push(block); pending.delete(source) }
  items.forEach((item, at) => {
    const source = item.line.containerId ?? item.line.src ?? ''
    if (!item.level) { flush(source); blocks.push({ at, items: [item] }); return }
    const header = levelOf(item.text) && !/^\s|^Traceback |\b\w+(?:Error|Exception):/.test(item.text)
    const previous = pending.get(source)
    const anotherTrace = /^Traceback /.test(item.text) && previous?.items.some((line) => /^Traceback /.test(line.text))
    if (header || anotherTrace || previous?.items[0].level !== item.level) flush(source)
    if (!pending.has(source)) pending.set(source, { at, items: [] })
    pending.get(source)?.items.push(item)
  })
  for (const source of pending.keys()) flush(source)
  const grouped = new Map<string, Shown>()
  const result: Shown[] = []
  for (const block of blocks.sort((a, b) => a.at - b.at)) {
    const first = block.items[0]
    const text = block.items.map((item) => item.text).join('\n')
    const key = JSON.stringify([first.line.containerId ?? first.line.src, first.level, text])
    const existing = first.level ? grouped.get(key) : undefined
    if (existing) { existing.count++; continue }
    const record = { ...first, text, line: { ...first.line, m: block.items.map((item) => item.line.m).join('\n') } }
    if (first.level) grouped.set(key, record)
    result.push(record)
  }
  return result
}

/** Keep surrounding unfiltered lines from the affected source instead of sending only isolated errors. */
export function incidentLines(all: Shown[], visible: Shown[]): Shown[] {
  const last = [...visible].reverse().find((item) => item.level) ?? visible.at(-1)
  if (!last) return []
  const source = last.line.containerId ?? last.line.src
  const own = all.filter((item) => (item.line.containerId ?? item.line.src) === source)
  let at = own.findIndex((item) => item.line === last.line)
  if (at < 0) return visible.slice(-300)
  // Walk back to the start of a traceback when the last visible error is its closing exception.
  let start = at
  while (start > 0 && own[start - 1].level === last.level && at - start < 240) start--
  start = Math.max(0, start - 20)
  let end = Math.min(own.length, at + 21)
  while (end < own.length && own[end].level === last.level && end - start < 300) end++
  return own.slice(start, Math.min(end, start + 300))
}
