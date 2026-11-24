import { createHash } from 'node:crypto'
import path from 'node:path'
import yaml from 'js-yaml'
import { memorySections } from './sections.mjs'

export const TYPES = Object.freeze(['context', 'project', 'note', 'identity', 'skill'])
const TYPE_SET = new Set(TYPES)

export const SEED_URI = 'memory://context/global/memory-system'
export const TRASH_URI_RE = /^trash:\/\/([a-f0-9-]{36})$/
export const TRASH_RETENTION_MS = 72 * 60 * 60 * 1000
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export class KnowledgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'KnowledgeError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details }
  }
}

export function parseUri(uri) {
  const match = typeof uri === 'string' && /^memory:\/\/(context|project|note|identity|skill)\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(uri)
  if (!match || match[2].split('/').some(s => !SEGMENT_RE.test(s) || s.endsWith('.') || s.includes('.sync-conflict-') || RESERVED_RE.test(s))) {
    throw new KnowledgeError('INVALID_URI', 'Use memory://<type>/<ascii-path> without traversal segments.')
  }
  return { uri, type: match[1], relative: match[2] }
}

export function fileFor(root, uri) {
  const { type, relative } = parseUri(uri)
  if (type === 'skill') return path.join(root, 'skill', ...relative.split('/'), 'SKILL.md')
  return path.join(root, type, ...relative.split('/')) + '.md'
}

export function archiveFileFor(root, uri) {
  return fileFor(path.join(root, 'archive'), uri)
}

export function isArchivedPath(root, filePath) {
  const archiveRoot = path.resolve(root, 'archive')
  const resolved = path.resolve(filePath)
  const relative = path.relative(archiveRoot, resolved)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function pathToUri(root, filePath) {
  const baseRoot = isArchivedPath(root, filePath) ? path.resolve(root, 'archive') : path.resolve(root)
  const relative = path.relative(baseRoot, path.resolve(filePath))
  const parts = relative.split(path.sep).filter(Boolean)
  const type = parts.shift()
  if (!TYPE_SET.has(type) || parts.length === 0 || !parts.at(-1).endsWith('.md')) {
    throw new KnowledgeError('INVALID_PATH', `Not a knowledge document: ${filePath}`)
  }
  if (type === 'skill') {
    if (parts.at(-1) !== 'SKILL.md') {
      throw new KnowledgeError('INVALID_PATH', `Not a skill root document: ${filePath}`)
    }
    parts.pop()
    if (parts.length === 0) throw new KnowledgeError('INVALID_PATH', `Empty skill URI: ${filePath}`)
    return parseUri(`memory://skill/${parts.join('/')}`).uri
  }
  parts[parts.length - 1] = parts.at(-1).slice(0, -3)
  return parseUri(`memory://${type}/${parts.join('/')}`).uri
}

export function isProjectSubnote(uri) {
  return typeof uri === 'string' && uri.startsWith('memory://project/') && uri.slice('memory://project/'.length).includes('/')
}

export function normalizeProjectScope(project) {
  if (typeof project !== 'string' || !project.trim()) {
    throw new KnowledgeError('INVALID_INPUT', 'project must be a non-empty project ID or memory://project/<id> URI.')
  }
  let relative = project.trim()
  if (relative.startsWith('memory://')) {
    if (!relative.startsWith('memory://project/')) {
      throw new KnowledgeError('INVALID_INPUT', 'project must be a project ID or memory://project/<id> URI.')
    }
    relative = relative.slice('memory://project/'.length)
  }
  relative = relative.replace(/^\/+|\/+$/g, '')
  if (!relative) {
    throw new KnowledgeError('INVALID_INPUT', 'project must be a non-empty project ID or memory://project/<id> URI.')
  }
  return parseUri(`memory://project/${relative}`).relative
}

export function matchesProjectScope(uri, scope) {
  const prefix = `memory://project/${scope}`
  return uri === prefix || uri.startsWith(`${prefix}/`)
}

export function projectVisible(uri, { project, includeSubnotes = true } = {}) {
  if (project) return matchesProjectScope(uri, project)
  if (!includeSubnotes && isProjectSubnote(uri)) return false
  return true
}

export function stringArray(value, field) {
  if (!Array.isArray(value) || value.some(s => typeof s !== 'string' || !s.trim())) {
    throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be an array of non-empty strings.`)
  }
  return [...new Set(value.map(s => s.trim()))]
}

export function cleanArchiveFields(frontmatter) {
  const result = { ...frontmatter }
  delete result.archived
  if (result.status === 'archived') delete result.status
  return result
}

export function validate(uri, input) {
  const parsed = parseUri(uri)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new KnowledgeError('INVALID_DOCUMENT', 'Frontmatter must be an object.')
  }
  const fm = { ...input }
  if ((fm.type !== undefined && fm.type !== parsed.type) || (fm.uri !== undefined && fm.uri !== uri)) {
    throw new KnowledgeError('INVALID_DOCUMENT', 'Frontmatter type/URI must match the file path.')
  }
  fm.type = parsed.type
  fm.uri = uri
  if (typeof fm.name !== 'string' || !fm.name.trim()) {
    throw new KnowledgeError('INVALID_DOCUMENT', 'A memory needs a name.')
  }
  if (fm.description !== undefined && typeof fm.description !== 'string') {
    throw new KnowledgeError('INVALID_DOCUMENT', 'description must be text.')
  }
  if ((fm.type === 'project' || fm.type === 'skill') && !fm.description?.trim()) {
    throw new KnowledgeError('INVALID_DOCUMENT', `A ${fm.type} needs a description.`)
  }
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
  for (const field of ['archived', 'ambient', 'pinned']) {
    if (fm[field] !== undefined && typeof fm[field] !== 'boolean') {
      throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be boolean.`)
    }
  }
  if (fm.scope !== undefined && typeof fm.scope !== 'string') stringArray(fm.scope, 'scope')
  if (fm.status !== undefined && typeof fm.status !== 'string') throw new KnowledgeError('INVALID_DOCUMENT', 'status must be text.')
  if (fm.updatedBy !== undefined && typeof fm.updatedBy !== 'string') throw new KnowledgeError('INVALID_DOCUMENT', 'updatedBy must be text.')
  for (const field of ['created', 'updated']) {
    if (fm[field] !== undefined && (typeof fm[field] !== 'string' || !Number.isFinite(Date.parse(fm[field])))) {
      throw new KnowledgeError('INVALID_DOCUMENT', `${field} must be a date string.`)
    }
  }
  if (fm.version !== undefined && (!Number.isInteger(fm.version) || fm.version < 1)) {
    throw new KnowledgeError('INVALID_DOCUMENT', 'version must be a positive integer.')
  }
  return fm
}

export function validateContentSections(body) {
  const { warnings } = memorySections(body)
  if (warnings.length) {
    throw new KnowledgeError('INVALID_CONTENT_SECTIONS', 'History markers must be paired and non-nested; code examples may be fenced.', { warnings })
  }
}

export function parseDocument(raw, uri) {
  const text = raw.replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) throw new KnowledgeError('INVALID_DOCUMENT', 'Missing YAML frontmatter.')
  let fm
  try {
    fm = yaml.load(match[1], { schema: yaml.JSON_SCHEMA })
  } catch {
    throw new KnowledgeError('INVALID_DOCUMENT', 'Invalid YAML frontmatter.')
  }
  return { frontmatter: validate(uri, fm), body: text.slice(match[0].length) }
}

export function serialize(frontmatter, body) {
  if (typeof body !== 'string') throw new KnowledgeError('INVALID_INPUT', 'body must be text.')
  return `---\n${yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: 120 }).trimEnd()}\n---\n${body.replaceAll('\r\n', '\n')}`
}

export const etag = text => `sha256:${createHash('sha256').update(text).digest('hex')}`
