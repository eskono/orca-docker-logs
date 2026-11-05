// Links in log text: web addresses, and source locations in stack traces.

export type LogLink =
  | { start: number; end: number; kind: 'url'; url: string }
  | { start: number; end: number; kind: 'file'; file: string; line: number; column?: number }

const WEB = /\bhttps?:\/\/[^\s"'<>`]+/g
/** Python: `File "/app/x.py", line 42`; the link covers the path. */
const PYTHON = /File "(\/[^"\n]+)", line (\d+)/g
/** PHP: `in /var/www/x.php on line 12`. */
const PHP = /(\/(?:[\w.@+-]+\/)*[\w.@+-]+\.php) on line (\d+)/g
/** `/abs/path/file.ext:line[:column]`: Node, Go, Ruby, Rust, TypeScript and most others. */
const PATH_LINE = /(\/(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z]\w*):(\d+)(?::(\d+))?/g

export function findLinks(text: string): LogLink[] {
  const found: LogLink[] = []
  for (const m of text.matchAll(WEB)) {
    const raw = m[0].replace(/[.,;:!?'")\]}]+$/, '')
    // Servers announce 0.0.0.0, which browsers do not open everywhere; it is this machine.
    found.push({ start: m.index, end: m.index + raw.length, kind: 'url', url: raw.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/, '$1localhost') })
  }
  for (const m of text.matchAll(PYTHON)) {
    const start = m.index + 'File "'.length
    found.push({ start, end: start + m[1].length, kind: 'file', file: m[1], line: Number(m[2]) })
  }
  for (const m of text.matchAll(PHP)) {
    found.push({ start: m.index, end: m.index + m[1].length, kind: 'file', file: m[1], line: Number(m[2]) })
  }
  for (const m of text.matchAll(PATH_LINE)) {
    const column = m[3] ? Number(m[3]) : undefined
    found.push({ start: m.index, end: m.index + m[0].length, kind: 'file', file: m[1], line: Number(m[2]), ...(column ? { column } : {}) })
  }
  // Earliest first; a match inside another (a path within a URL) loses.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: LogLink[] = []
  for (const link of found) {
    if (link.kind === 'file' && link.line === 0) continue
    const last = kept.at(-1)
    if (!last || link.start >= last.end) kept.push(link)
  }
  return kept
}
