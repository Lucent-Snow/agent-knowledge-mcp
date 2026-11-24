// Explicit, source-preserving memory roles. Markers are opt-in and never
// inferred from headings or dates.

export const HISTORY_START = '<!-- knowledge:history -->'
export const HISTORY_END = '<!-- /knowledge:history -->'
export const PROJECTION_VERSION = 'current-sections-v1'

export function memorySections(body = '') {
  const spans = []
  const warnings = []
  let cursor = 0
  let history = false
  let fence = null

  for (const line of String(body ?? '').matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue
    if (/^(?: {4}|\t)/.test(line[0])) continue
    const text = line[0].trim()
    const marker = /^(`{3,}|~{3,})/.exec(text)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && /^(`+|~+)\s*$/.test(text)) fence = null
      continue
    }
    if (fence || (text !== HISTORY_START && text !== HISTORY_END)) continue
    const start = text === HISTORY_START
    if (start === history) {
      warnings.push({ code: 'INVALID_CONTENT_SECTIONS', offset: line.index })
      continue
    }
    if (line.index > cursor) spans.push({ role: history ? 'history' : 'current', start: cursor, end: line.index })
    spans.push({ role: 'marker', start: line.index, end: line.index + line[0].length })
    history = start
    cursor = line.index + line[0].length
  }

  if (cursor < String(body ?? '').length) {
    spans.push({ role: history ? 'history' : 'current', start: cursor, end: String(body ?? '').length })
  }
  if (history) warnings.push({ code: 'UNCLOSED_CONTENT_HISTORY', offset: String(body ?? '').length })
  return { spans, warnings }
}

export function memoryProjection(body, { includeHistory = false } = {}) {
  const text = String(body ?? '')
  const { spans } = memorySections(text)
  return spans
    .map((span) => (span.role === 'marker' || (span.role === 'history' && !includeHistory))
      ? text.slice(span.start, span.end).replace(/[^\r\n]/g, ' ')
      : text.slice(span.start, span.end))
    .join('')
}

export function contentRoleAt(body, offset = 0) {
  return memorySections(body).spans.find((span) => span.start <= offset && offset < span.end)?.role ?? 'current'
}
