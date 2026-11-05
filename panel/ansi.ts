// Splits a log line into styled segments by its ANSI SGR codes; other escape sequences are dropped.

export type Style = {
  /** 0-15 for the theme palette, or a CSS colour for 256-colour and true-colour codes. */
  fg?: number | string
  bg?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export type Segment = { text: string; style: Style }

// CSI (parameters, intermediates, final byte), OSC up to BEL/ST, or a two-byte escape.
const ESCAPE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g
const SGR_PARAMS = /^[0-9;:]*$/

function color256(n: number): number | string {
  if (n < 16) return n
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`
}

/** Reads an extended colour (`38;5;n` or `38;2;r;g;b`) at `codes[i]`; returns it and how many codes it used. */
function extended(codes: number[], i: number): [number | string | undefined, number] {
  if (codes[i + 1] === 5 && codes[i + 2] !== undefined) return [color256(codes[i + 2]), 3]
  if (codes[i + 1] === 2 && codes[i + 4] !== undefined) return [`rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`, 5]
  return [undefined, 1]
}

function apply(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)))
  let next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) next = {}
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 22) next.bold = next.dim = false
    else if (c === 23) next.italic = false
    else if (c === 24) next.underline = false
    else if (c >= 30 && c <= 37) next.fg = c - 30
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8
    else if (c === 39) delete next.fg
    else if (c >= 40 && c <= 47) next.bg = c - 40
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8
    else if (c === 49) delete next.bg
    else if (c === 38 || c === 48) {
      const [value, used] = extended(codes, i)
      if (value !== undefined) next[c === 38 ? 'fg' : 'bg'] = value
      i += used - 1
    }
  }
  return next
}

/** What a terminal would show for a line that redraws itself with carriage returns. */
function afterCarriageReturns(line: string): string {
  const parts = line.split('\r').filter((part) => part !== '')
  return parts.at(-1) ?? ''
}

export function parseAnsi(line: string): Segment[] {
  const text = afterCarriageReturns(line)
  const segments: Segment[] = []
  let style: Style = {}
  let last = 0
  for (const match of text.matchAll(ESCAPE)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), style })
    if (match[2] === 'm' && SGR_PARAMS.test(match[1] ?? '')) style = apply(style, match[1] ?? '')
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), style })
  return segments
}

/** The line as plain text, for filtering. */
export function stripAnsi(line: string): string {
  return parseAnsi(line).map((s) => s.text).join('')
}
