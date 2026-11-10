// Error and warning lines in common log formats: plain levels, logfmt, JSON loggers, stack traces.

export type Level = 'error' | 'warn' | null

// Upper-case level words only, so prose like "no error found" stays a plain line.
const ERROR_WORDS =
  /\b(ERROR|FATAL|CRITICAL|PANIC|EMERG|EMERGENCY|SEVERE)\b|Traceback \(most recent call last\)|\b[A-Z][A-Za-z0-9_]*(Error|Exception)(?=[:(\s]|$)/
const ERROR_FIELDS =
  /\blevel=(error|fatal|crit|critical|panic)\b|"(level|severity|lvl)"\s*:\s*"(error|fatal|crit|critical|panic)"|"level"\s*:\s*(50|60)\b|\[(error|fatal|crit|critical)\]/i
const WARN_WORDS = /\b(WARN|WARNING)\b/
const WARN_FIELDS = /\blevel=warn(ing)?\b|"(level|severity|lvl)"\s*:\s*"warn(ing)?"|"level"\s*:\s*40\b|\[warn(ing)?\]/i

export function levelOf(text: string): Level {
  if (/^(?:Error:|panic:)/.test(text)) return 'error'
  if (ERROR_WORDS.test(text) || ERROR_FIELDS.test(text)) return 'error'
  if (WARN_WORDS.test(text) || WARN_FIELDS.test(text)) return 'warn'
  return null
}

/** Each line's level; indented lines right after an error or warning (a stack trace) share it. */
export function levels(texts: string[], sources: string[] = []): Level[] {
  const carried = new Map<string, Level>()
  return texts.map((text, i) => {
    const source = sources[i] ?? ''
    const own = levelOf(text)
    if (own) { carried.set(source, own); return own }
    if (carried.get(source) && (/^\s+\S/.test(text) || /^goroutine \d+ \[|^[\w./*]+\([^\n]*\)$|^\/[^\s]+\.[a-z]+:\d+/.test(text))) return carried.get(source) ?? null
    carried.delete(source)
    return null
  })
}

export type Tone = 'debug' | 'info' | 'warn' | 'error'

// Upper-case level words, or the value of a logfmt / JSON level field (any case).
const LEVEL_WORD = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL|PANIC|SEVERE)\b/
const LEVEL_FIELD = /(?:\blevel=|"(?:level|severity|lvl)"\s*:\s*")(trace|debug|info|notice|warn|warning|error|fatal|critical|crit|panic)\b/i

function toneOf(word: string): Tone {
  const w = word.toLowerCase()
  if (w === 'trace' || w === 'debug') return 'debug'
  if (w === 'info' || w === 'notice') return 'info'
  if (w === 'warn' || w === 'warning') return 'warn'
  return 'error'
}

/** Where the line names its level, to colour that word in logs that carry no colours of their own. */
export function levelToken(text: string): { start: number; end: number; tone: Tone } | null {
  const word = LEVEL_WORD.exec(text)
  const field = LEVEL_FIELD.exec(text)
  const fieldStart = field ? field.index + field[0].length - field[1].length : Infinity
  if (word && word.index <= fieldStart) return { start: word.index, end: word.index + word[1].length, tone: toneOf(word[1]) }
  if (field) return { start: fieldStart, end: fieldStart + field[1].length, tone: toneOf(field[1]) }
  return null
}
