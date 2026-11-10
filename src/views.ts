import type { SavedView } from './protocol'

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/
export function validateViews(value: unknown): SavedView[] {
  if (!Array.isArray(value) || value.length > 20 || Buffer.byteLength(JSON.stringify(value)) > 48_000) throw new Error('Use at most 20 views (48 KB total)')
  const ids = new Set<string>()
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id) || ids.has(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 60 ||
      !(item.services === null || Array.isArray(item.services) && item.services.length <= 200 && item.services.every((s: unknown) => typeof s === 'string' && NAME.test(s))) ||
      typeof item.filter !== 'string' || item.filter.length > 512 || typeof item.search !== 'string' || item.search.length > 512 ||
      !['all', 'warn', 'error'].includes(item.level) || !['tail', '5m', '15m', '1h', 'start'].includes(item.window) ||
      ['group', 'json', 'wrap', 'timestamps'].some((key) => typeof item[key] !== 'boolean')) throw new Error('Invalid saved view')
    ids.add(item.id)
    return { id: item.id, name: item.name.trim(), services: item.services === null ? null : [...new Set<string>(item.services)], filter: item.filter, search: item.search,
      level: item.level, window: item.window, group: item.group, json: item.json, wrap: item.wrap, timestamps: item.timestamps }
  })
}
