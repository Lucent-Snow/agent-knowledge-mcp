import { createHash } from 'node:crypto'
import path from 'node:path'
import yaml from 'js-yaml'

export const TYPES = Object.freeze(['context', 'project', 'note', 'identity'])
export const SEED_URI = 'memory://context/global/memory-system'

export class KnowledgeError extends Error {
  constructor(code, message) { super(message); this.name = 'KnowledgeError'; this.code = code }
}

export function parseUri(uri) {
  const match = typeof uri === 'string' && /^memory:\/\/(context|project|note|identity)\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(uri)
  if (!match || match[2].split('/').some(s => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.endsWith('.') || s.includes('.sync-conflict-') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new KnowledgeError('INVALID_URI', 'Use memory://<type>/<ascii-path> without traversal segments.')
  }
  return { uri, type: match[1], relative: match[2] }
}

export function fileFor(root, uri) {
  const { type, relative } = parseUri(uri)
  return path.join(root, type, ...relative.split('/')) + '.md'
}

export function stringArray(value, field) {
  if (!Array.isArray(value) || value.some(s => typeof s !== 'string' || !s.trim())) {
    throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be an array of non-empty strings.`)
  }
  return [...new Set(value.map(s => s.trim()))]
}

export function validate(uri, input) {
  const parsed = parseUri(uri)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new KnowledgeError('INVALID_DOCUMENT', 'Frontmatter must be an object.')
  const fm = { ...input }
  if ((fm.type !== undefined && fm.type !== parsed.type) || (fm.uri !== undefined && fm.uri !== uri)) {
    throw new KnowledgeError('INVALID_DOCUMENT', 'Frontmatter type/URI must match the file path.')
  }
  fm.type = parsed.type; fm.uri = uri
  if (typeof fm.name !== 'string' || !fm.name.trim()) throw new KnowledgeError('INVALID_DOCUMENT', 'A memory needs a name.')
  if (fm.description !== undefined && typeof fm.description !== 'string') throw new KnowledgeError('INVALID_DOCUMENT', 'description must be text.')
  if (fm.type === 'project' && !fm.description?.trim()) throw new KnowledgeError('INVALID_DOCUMENT', 'A project needs a description.')
  fm.tags = stringArray(fm.tags ?? [], 'tags')
  if (!Array.isArray(fm.links ?? [])) throw new KnowledgeError('INVALID_DOCUMENT', 'links must be an array.')
  fm.links = (fm.links ?? []).map(link => {
    const value = typeof link === 'string' ? { kind: 'related', to: link } : link
    if (!value || typeof value !== 'object' || typeof value.kind !== 'string' || !value.kind.trim()) {
      throw new KnowledgeError('INVALID_DOCUMENT', 'Each link needs kind and to.')
    }
    parseUri(value.to)
    return { ...value, kind: value.kind.trim() }
  })
  for (const field of ['archived', 'ambient']) {
    if (fm[field] !== undefined && typeof fm[field] !== 'boolean') throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be boolean.`)
  }
  if (fm.scope !== undefined && typeof fm.scope !== 'string') stringArray(fm.scope, 'scope')
  if (fm.status !== undefined && typeof fm.status !== 'string') throw new KnowledgeError('INVALID_DOCUMENT', 'status must be text.')
  for (const field of ['created', 'updated']) {
    if (fm[field] !== undefined && (typeof fm[field] !== 'string' || !Number.isFinite(Date.parse(fm[field])))) {
      throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be a date string.`)
    }
  }
  if (fm.version !== undefined && (!Number.isInteger(fm.version) || fm.version < 1)) throw new KnowledgeError('INVALID_DOCUMENT', 'version must be a positive integer.')
  return fm
}

export function parseDocument(raw, uri) {
  const text = raw.replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) throw new KnowledgeError('INVALID_DOCUMENT', 'Missing YAML frontmatter.')
  let fm
  try { fm = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) } catch { throw new KnowledgeError('INVALID_DOCUMENT', 'Invalid YAML frontmatter.') }
  return { frontmatter: validate(uri, fm), body: text.slice(match[0].length) }
}

export function serialize(frontmatter, body) {
  if (typeof body !== 'string') throw new KnowledgeError('INVALID_INPUT', 'body must be text.')
  return `---\n${yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: 120 }).trimEnd()}\n---\n${body.replaceAll('\r\n', '\n')}`
}

export const etag = text => `sha256:${createHash('sha256').update(text).digest('hex')}`

export function terms(query) {
  const result = []
  for (const token of String(query).toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) result.push(token.slice(i, i + 2))
    } else result.push(token)
  }
  return [...new Set(result)]
}

export function score(doc, query) {
  const tokens = terms(query)
  if (!tokens.length) return 0
  const fm = doc.frontmatter
  const fields = { uri: [doc.uri, 8], name: [fm.name, 10], description: [fm.description ?? '', 6], tags: [fm.tags.join(' '), 5], body: [doc.body, 2], links: [fm.links.map(l => `${l.kind} ${l.to}`).join(' '), 4] }
  let value = 0
  for (const [text, weight] of Object.values(fields)) value += weight * tokens.filter(t => text.toLowerCase().includes(t)).length / tokens.length
  const phrase = query.trim().toLowerCase()
  if (phrase.length >= 4 && [fm.name, fm.description ?? '', doc.body].some(t => t.toLowerCase().includes(phrase))) value += 6
  return value
}
