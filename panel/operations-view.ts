import type { Operation } from '../src/protocol'
import { reconcileLog } from './log-view'

export function renderOperations(root: HTMLElement, operations: Operation[], open: (id: string) => void): void {
  const document = root.ownerDocument
  const expanded = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map((node) => node.dataset.operation))
  reconcileLog(root, operations.map((operation) => ({
    key: JSON.stringify(operation),
    create: () => {
      const card = document.createElement('section')
      card.className = `operation operation-${operation.status}`
      const header = document.createElement('div')
      header.className = 'row'
      const title = document.createElement('strong')
      title.textContent = operation.title
      const status = document.createElement('span')
      status.className = 'operation-status'
      status.textContent = operation.status === 'succeeded' ? 'Completed' : operation.status === 'failed' ? `Failed${operation.exitCode !== null ? ` (${operation.exitCode})` : ''}` : operation.status === 'unknown' ? 'Result not confirmed' : 'Running…'
      header.append(title, status)
      if (operation.terminalId) {
        const button = document.createElement('button')
        button.textContent = 'Terminal'
        button.title = 'Show this operation’s terminal'
        button.addEventListener('click', () => open(operation.id))
        header.append(button)
      }
      card.append(header)
      const time = document.createElement('span')
      time.className = 'hint'
      time.textContent = new Date(operation.startedAt).toLocaleString() + (operation.finishedAt ? ` · ${Math.max(0, Math.round((Date.parse(operation.finishedAt) - Date.parse(operation.startedAt)) / 1000))}s` : '')
      card.append(time)
      if (operation.lines.length) {
        const details = document.createElement('details')
        details.dataset.operation = operation.id
        details.open = expanded.has(operation.id)
        const summary = document.createElement('summary')
        summary.textContent = operation.lines.at(-1) || 'Output'
        const output = document.createElement('pre')
        output.textContent = operation.lines.join('\n')
        details.append(summary, output)
        card.append(details)
      }
      return card
    }
  })))
}
