import type { DockerContext, ServiceRow } from './protocol'
import { problemOf } from './status'

export function diagnosticLines(row: ServiceRow): string[] {
  const details = [`${row.name}: ${row.state}${row.health ? ` / ${row.health}` : ''}`]
  if (row.exitCode !== null && row.state !== 'running') details.push(`Exit code: ${row.exitCode}`)
  if (row.oomKilled) details.push('OOM killed: the container ran out of memory')
  details.push(`Restarts: ${row.restartCount}`)
  if (row.stateError) details.push(`Runtime error: ${row.stateError}`)
  if (row.healthLog) details.push(`Last health check: ${row.healthLog}`)
  if (row.startedAt) details.push(`Started: ${row.startedAt}`)
  if (row.finishedAt) details.push(`Finished: ${row.finishedAt}`)
  return details
}

export function diagnosticSummary(project: string, rows: ServiceRow[], context: DockerContext): string {
  return [
    `Compose project: ${project}`,
    `Docker context: ${context.name}${context.endpoint ? ` (${context.endpoint})` : ''}`,
    ...rows.flatMap((row) => [...diagnosticLines(row), ...(problemOf(row) ? [`Problem: ${problemOf(row)}`] : []), ''])
  ].join('\n')
}
