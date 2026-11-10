import { findLinks } from './links'

export type FrameKind = 'project' | 'library' | 'unknown'
export type TraceLine = { text: string; frame: boolean; kind: FrameKind }
const LIBRARY = /(?:^|\/)(?:node_modules|site-packages|dist-packages|vendor|\.venv)(?:\/|$)|\bnode:(?:internal|events|async_hooks)|\/usr\/local\/go\/src\//
const FRAME = /^\s*(?:File ["']|at\s|#\d+\s|\/[^\s]+:\d+)|^\/[^\s]+\.[a-z]+:\d+/i

/** Classify only positively identified project files or well-known library paths. */
export function traceLines(text: string, resolve: (file: string) => string | null | undefined): TraceLine[] | null {
  const lines = text.split('\n')
  const parsed = lines.map((text): TraceLine => {
    const files = findLinks(text).filter((link) => link.kind === 'file')
    const project = files.some((link) => link.kind === 'file' && !!resolve(link.file))
    return { text, frame: FRAME.test(text) || files.length > 0, kind: project ? 'project' : LIBRARY.test(text) ? 'library' : 'unknown' }
  })
  return parsed.some((line) => line.frame) && lines.length > 1 ? parsed : null
}
