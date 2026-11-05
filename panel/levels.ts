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
  if (ERROR_WORDS.test(text) || ERROR_FIELDS.test(text)) return 'error'
  if (WARN_WORDS.test(text) || WARN_FIELDS.test(text)) return 'warn'
  return null
}

/** Each line's level; indented lines right after an error or warning (a stack trace) share it. */
export function levels(texts: string[]): Level[] {
  let carried: Level = null
  return texts.map((text) => {
    const own = levelOf(text)
    if (own) return (carried = own)
    if (carried && /^\s+\S/.test(text)) return carried
    return (carried = null)
  })
}
