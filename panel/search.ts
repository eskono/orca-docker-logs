export type Match = { start: number; end: number }

/** Literal, case-insensitive search; cap work before creating highlight nodes. */
export function findMatches(text: string, query: string, limit = 1000): Match[] {
  if (!query || limit < 1) return []
  const pattern = query.slice(0, 512).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches: Match[] = []
  for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
    matches.push({ start: match.index, end: match.index + match[0].length })
    if (matches.length >= limit) break
  }
  return matches
}

let sequence = 0
/** Highlight across ANSI spans and links without replacing their parent elements/listeners. */
export function highlightMatches(root: HTMLElement, query: string, limit: number): void {
  const document = root.ownerDocument
  const walker = document.createTreeWalker(root, 4, {
    acceptNode(node) { return node.parentElement?.closest('[data-search-ignore]') ? 2 : 1 }
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const ranges = findMatches(nodes.map((node) => node.data).join(''), query, limit)
  const id = ++sequence
  let offset = 0, firstRange = 0
  for (const node of nodes) {
    const start = offset
    offset += node.length
    while (firstRange < ranges.length && ranges[firstRange].end <= start) firstRange++
    const fragment = document.createDocumentFragment()
    let cursor = 0, touched = false
    for (let i = firstRange; i < ranges.length && ranges[i].start < offset; i++) {
      const from = Math.max(0, ranges[i].start - start)
      const to = Math.min(node.length, ranges[i].end - start)
      if (from > cursor) fragment.append(document.createTextNode(node.data.slice(cursor, from)))
      const mark = document.createElement('mark')
      mark.className = 'search-hit'
      mark.dataset.searchMatch = `${id}:${i}`
      mark.textContent = node.data.slice(from, to)
      fragment.append(mark)
      cursor = to
      touched = true
    }
    if (touched) {
      if (cursor < node.length) fragment.append(document.createTextNode(node.data.slice(cursor)))
      node.replaceWith(fragment)
    }
  }
}

export function revealLogNode(node: HTMLElement): void {
  let parent = node.parentElement
  while (parent) { if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true; parent = parent.parentElement }
  node.scrollIntoView?.({ block: 'center' })
}

export class SearchNavigation {
  private groups: HTMLElement[][] = []
  private active: string | null = null
  index = -1
  get count(): number { return this.groups.length }
  refresh(root: HTMLElement): void {
    const groups = new Map<string, HTMLElement[]>()
    for (const node of root.querySelectorAll<HTMLElement>('.search-hit')) {
      const key = node.dataset.searchMatch!
      groups.set(key, [...(groups.get(key) ?? []), node])
    }
    this.groups = [...groups.values()]
    const found = this.groups.findIndex((group) => group[0].dataset.searchMatch === this.active)
    this.index = found >= 0 ? found : this.count ? 0 : -1
    this.paint()
  }
  move(delta: number): void {
    if (!this.count) return
    this.index = (this.index + delta + this.count) % this.count
    this.paint()
    for (const node of this.groups[this.index]) revealLogNode(node)
  }
  private paint(): void {
    this.active = this.groups[this.index]?.[0].dataset.searchMatch ?? null
    this.groups.forEach((group, i) => group.forEach((node) => node.classList.toggle('current-match', i === this.index)))
  }
}
