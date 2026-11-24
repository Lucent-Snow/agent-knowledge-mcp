// Optional incremental dense vector cache for active note/project documents.
// Rebuildable SQLite cache outside the synced corpus; never owns canonical state.
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KnowledgeError, normalizeProjectScope, projectVisible } from './format.mjs'
import { defaultCacheDir } from './lexical-index.mjs'
import { modelEligible } from './ranking.mjs'
import { PROJECTION_VERSION, contentRoleAt, memoryProjection, memorySections } from './sections.mjs'

export const CHUNK_VERSION = 'paragraph-v1-640-800-64-est'
const SCHEMA_VERSION = '1'
const queryCache = new Map()
const sha256 = value => createHash('sha256').update(value).digest('hex')

export function estimateTokens(text = '') {
  let count = 0
  for (const run of String(text).matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})\S)+|\s+/gu)) {
    const token = run[0]
    if (/^\s+$/.test(token)) continue
    if (/\p{Script=Han}/u.test(token)) count += Math.ceil(token.length * 1.5)
    else count += Math.ceil(token.length / 3.5)
  }
  return count
}

function safeBoundary(text, offset) {
  return offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') ? offset - 1 : offset
}

function fittingEnd(text, start, end, fits) {
  let low = start
  let high = end
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(text.slice(start, middle))) low = middle
    else high = middle - 1
  }
  return safeBoundary(text, low)
}

function splitSections(body) {
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter(m => m[0])
    .map(m => ({ text: m[0].replace(/\r?\n$/, ''), start: m.index, end: m.index + m[0].length }))
  const out = []
  const headings = []
  let contentStart = 0
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && /^\s{0,3}(?:`+|~+)\s*$/.test(line.text)) fence = null
      continue
    }
    if (fence) continue
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text)
    const setext = !atx && line.text.trim() && /^ {0,3}(=+|-+)\s*$/.exec(lines[i + 1]?.text ?? '')
    if (!atx && !setext) continue
    if (contentStart < line.start) out.push({ start: contentStart, end: line.start, headings: headings.filter(Boolean) })
    const level = atx ? atx[1].length : setext[1][0] === '=' ? 1 : 2
    headings.length = level
    headings[level - 1] = atx ? atx[2] : line.text.trim()
    contentStart = setext ? lines[++i].end : line.end
  }
  if (contentStart < body.length) out.push({ start: contentStart, end: body.length, headings: headings.filter(Boolean) })
  return out
}

export function chunkDocument(doc, count = estimateTokens, { targetTokens = 640, maxTokens = 800, overlapTokens = 64, contextTokens = 128 } = {}) {
  if (maxTokens < 8 || targetTokens > maxTokens || overlapTokens >= maxTokens) throw new Error('Invalid chunk configuration')
  const originalBody = doc.body ?? ''
  const body = memoryProjection(originalBody)
  const chunks = []
  const lineStarts = [0]
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStarts.push(i + 1)
  const lineAt = offset => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (lineStarts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const currentSpans = memorySections(originalBody).spans.filter(s => s.role === 'current')
  const parsedSections = splitSections(body)
  const selectedSections = parsedSections.flatMap(section =>
    currentSpans
      .map(span => ({ ...section, start: Math.max(section.start, span.start), end: Math.min(section.end, span.end) }))
      .filter(s => s.start < s.end))

  for (const section of selectedSections) {
    const name = doc.name ?? doc.frontmatter?.name ?? ''
    let context = [name, section.headings.join(' > ')].filter(Boolean).join('\n')
    if (count(context) > contextTokens) {
      context = context.slice(0, fittingEnd(context, 0, context.length, text => count(text) <= contextTokens))
    }
    const inputFor = text => context ? `${context}\n\n${text}` : text
    const fits = text => count(inputFor(text)) <= maxTokens
    const add = (start, end) => {
      const text = body.slice(start, end)
      if (!text.trim()) return
      const input = inputFor(text)
      const tokens = count(input)
      if (tokens > maxTokens) throw new Error('Chunk exceeded its token budget')
      chunks.push({ id: sha256(input), input, text, start, end, startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)), headings: section.headings, tokens })
    }

    const paragraphEnds = [...body.slice(section.start, section.end).matchAll(/\r?\n[\t ]*\r?\n/g)]
      .map(m => section.start + m.index + m[0].length)
    paragraphEnds.push(section.end)
    let start = section.start
    let end = start
    for (const next of paragraphEnds) {
      if (fits(body.slice(start, next))) {
        end = next
        if (count(inputFor(body.slice(start, end))) >= targetTokens) {
          add(start, end)
          start = end
        }
        continue
      }
      if (end > start) { add(start, end); start = end }
      while (!fits(body.slice(start, next))) {
        let split = fittingEnd(body, start, next, fits)
        if (split <= start) throw new Error('Chunker cannot fit a single source character')
        const tailStart = start + Math.floor((split - start) * 0.75)
        const tail = body.slice(tailStart, split)
        const boundaries = [...tail.matchAll(/[。！？.!?;；\n](?:\s|$)?/g)]
        if (boundaries.length) split = safeBoundary(body, tailStart + boundaries.at(-1).index + boundaries.at(-1)[0].length)
        add(start, split)
        let overlap = split
        if (overlapTokens > 0) {
          let low = start + 1
          let high = split
          while (low < high) {
            const mid = Math.floor((low + high) / 2)
            if (count(body.slice(mid, split)) <= overlapTokens) high = mid
            else low = mid + 1
          }
          overlap = safeBoundary(body, low)
        }
        start = overlap > start ? overlap : split
      }
      end = next
    }
    if (end > start) add(start, end)
  }
  return chunks.map((chunk, ordinal) => ({ ...chunk, ordinal }))
}

export class VectorStore {
  constructor(root, { providers, dbPath } = {}) {
    this.root = root
    this.providers = providers
    this.dbPath = dbPath ?? path.join(defaultCacheDir(root), 'vectors.sqlite')
    this.db = null
  }

  get enabled() {
    return Boolean(this.providers?.embed)
  }

  _open() {
    if (this.db) return this.db
    if (this.dbPath !== ':memory:') mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.dbPath)
    if (this.dbPath !== ':memory:') {
      try { chmodSync(this.dbPath, 0o600) } catch {}
    }
    db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(
        uri TEXT PRIMARY KEY, type TEXT NOT NULL, etag TEXT NOT NULL, status TEXT NOT NULL,
        tags TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        projection_version TEXT NOT NULL, indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vectors(hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, tokens INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(
        uri TEXT NOT NULL REFERENCES documents(uri) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES vectors(hash),
        start INTEGER NOT NULL, end INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        headings TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(uri, ordinal)
      );
      CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
    `)
    const expected = { schema: SCHEMA_VERSION, model: this.providers.embedModel, chunkVersion: CHUNK_VERSION }
    for (const [key, value] of Object.entries(expected)) {
      const saved = db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
      if (saved && saved !== value) {
        db.close()
        if (this.dbPath === ':memory:') throw new Error(`Vector cache mismatch on ${key}`)
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.dbPath}${suffix}`, { force: true })
        return this._open()
      }
      if (!saved) db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(key, value)
    }
    this.db = db
    return db
  }

  _transaction(fn) {
    const db = this._open()
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async sync(docs) {
    if (!this.enabled) return
    const db = this._open()
    const eligible = docs.filter(modelEligible)
    const activeUris = new Set(eligible.map(d => d.uri))
    const existing = new Map(db.prepare('SELECT uri, etag, projection_version FROM documents').all().map(r => [r.uri, r]))

    for (const uri of existing.keys()) {
      if (!activeUris.has(uri)) db.prepare('DELETE FROM documents WHERE uri=?').run(uri)
    }

    const toIndex = eligible.filter(doc => {
      const saved = existing.get(doc.uri)
      return !saved || saved.etag !== doc.etag || saved.projection_version !== PROJECTION_VERSION
    })
    if (!toIndex.length) return

    const pendingChunks = new Map()
    const docChunks = []
    for (const doc of toIndex) {
      const chunks = chunkDocument(doc)
      docChunks.push({ doc, chunks })
      for (const chunk of chunks) {
        if (!db.prepare('SELECT 1 FROM vectors WHERE hash=?').get(chunk.id) && !pendingChunks.has(chunk.id)) {
          pendingChunks.set(chunk.id, chunk)
        }
      }
    }

    const missing = [...pendingChunks.values()]
    const savedDim = Number(db.prepare("SELECT value FROM meta WHERE key='dimensions'").get()?.value ?? 0)
    if (missing.length) {
      const embeddings = await this.providers.embed(missing.map(c => c.input))
      if (!Array.isArray(embeddings) || embeddings.length !== missing.length) {
        throw new Error('Embedding count mismatch')
      }
      const dims = embeddings[0]?.length
      if (!dims) throw new Error('Empty embedding vector')
      if (savedDim && dims !== savedDim) throw new Error('Embedding dimension mismatch')
      const rows = embeddings.map((values, i) => {
        if (!Array.isArray(values) || values.length !== dims || values.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
          throw new Error('Invalid embedding values')
        }
        const norm = Math.hypot(...values)
        if (!norm) throw new Error('Zero-norm embedding vector')
        const normalized = Float32Array.from(values, v => v / norm)
        return [missing[i].id, Buffer.from(normalized.buffer), dims, missing[i].tokens]
      })
      this._transaction(() => {
        if (!savedDim) db.prepare("INSERT OR REPLACE INTO meta VALUES('dimensions', ?)").run(String(dims))
        const putVec = db.prepare('INSERT OR IGNORE INTO vectors VALUES(?, ?, ?, ?)')
        for (const row of rows) putVec.run(...row)
      })
    }

    this._transaction(() => {
      const upsertDoc = db.prepare(`
        INSERT INTO documents VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO UPDATE SET
          type=excluded.type, etag=excluded.etag, status=excluded.status,
          tags=excluded.tags, name=excluded.name, description=excluded.description,
          projection_version=excluded.projection_version, indexed_at=excluded.indexed_at
      `)
      const delChunks = db.prepare('DELETE FROM chunks WHERE uri=?')
      const putChunk = db.prepare('INSERT INTO chunks VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const now = Date.now()
      for (const { doc, chunks } of docChunks) {
        const fm = doc.frontmatter ?? {}
        upsertDoc.run(
          doc.uri, doc.type, doc.etag, fm.status ?? doc.status ?? '',
          JSON.stringify(fm.tags ?? doc.tags ?? []), fm.name ?? doc.name ?? '',
          fm.description ?? doc.description ?? '', PROJECTION_VERSION, now,
        )
        delChunks.run(doc.uri)
        for (const chunk of chunks) {
          putChunk.run(doc.uri, chunk.ordinal, chunk.id, chunk.start, chunk.end, chunk.startLine, chunk.endLine, JSON.stringify(chunk.headings), chunk.text)
        }
      }
      db.prepare('DELETE FROM vectors WHERE hash NOT IN (SELECT hash FROM chunks)').run()
    })
  }

  async query(args, docs) {
    if (!this.enabled) throw new KnowledgeError('VECTORS_UNAVAILABLE', 'Embedding endpoint is not configured; lexical retrieval remains available.')
    if (!args.query?.trim()) throw new KnowledgeError('INVALID_INPUT', 'Vector search requires a query.')
    if (args.includeArchived) throw new KnowledgeError('INVALID_INPUT', 'Archived documents are outside the vector index.')
    if (args.includeHistory) throw new KnowledgeError('INVALID_INPUT', 'includeHistory applies only to lexical memory search.')
    const projectScope = args.project !== undefined ? normalizeProjectScope(args.project) : undefined
    if (projectScope && args.type && args.type !== 'project') return { hits: [], strategy: 'vector', warnings: [] }
    if (args.type && !['note', 'project'].includes(args.type)) return { hits: [], strategy: 'vector', warnings: [] }
    const includeSubnotes = args.includeSubnotes ?? Boolean(projectScope)

    await this.sync(docs)
    const cacheKey = JSON.stringify([this.providers.embedModel, args.query])
    if (!queryCache.has(cacheKey)) {
      queryCache.set(cacheKey, this.providers.embed([args.query]).then(v => v[0]).catch(error => { queryCache.delete(cacheKey); throw error }))
      if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value)
    }
    const rawVector = await queryCache.get(cacheKey)
    const norm = Math.hypot(...rawVector)
    if (!norm) return { hits: [], strategy: 'vector', warnings: [] }
    const queryVec = rawVector.map(v => v / norm)

    const db = this._open()
    const clauses = ['1=1']
    const params = []
    if (args.type) { clauses.push('d.type=?'); params.push(args.type) }
    if (args.status) { clauses.push('d.status=?'); params.push(args.status) }
    if (projectScope) {
      clauses.push('(d.uri=? OR substr(d.uri, 1, length(?))=?)')
      params.push(`memory://project/${projectScope}`, `memory://project/${projectScope}/`, `memory://project/${projectScope}/`)
    } else if (!includeSubnotes) {
      clauses.push("NOT (d.type='project' AND instr(substr(d.uri, 18), '/')>0)")
    }
    for (const tag of args.tags ?? []) {
      clauses.push('EXISTS(SELECT 1 FROM json_each(d.tags) WHERE value=?)')
      params.push(tag)
    }

    const byUriDoc = new Map(docs.map(d => [d.uri, d]))
    const best = new Map()
    const sql = `SELECT d.uri, d.type, d.name, d.description, d.tags, d.etag, c.ordinal, c.hash, c.start, c.end, c.start_line, c.end_line, c.headings, c.text, v.embedding, v.dimensions
      FROM chunks c JOIN documents d ON d.uri=c.uri JOIN vectors v ON v.hash=c.hash
      WHERE ${clauses.join(' AND ')}`
    for (const row of db.prepare(sql).iterate(...params)) {
      if (row.dimensions !== queryVec.length) continue
      if (!projectVisible(row.uri, { project: projectScope, includeSubnotes })) continue
      const current = byUriDoc.get(row.uri)
      if (!current || current.etag !== row.etag || current.archived) continue
      if (contentRoleAt(current.body ?? '', row.start) !== 'current') continue
      const embedding = new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength))
      let score = 0
      for (let i = 0; i < queryVec.length; i++) score += queryVec[i] * embedding[i]
      if (score <= 0 || score <= (best.get(row.uri)?.score ?? -1)) continue
      best.set(row.uri, {
        uri: row.uri,
        type: row.type,
        name: row.name,
        description: row.description,
        tags: JSON.parse(row.tags),
        etag: row.etag,
        score,
        excerpt: row.text.slice(0, 800),
        chunk: {
          id: row.hash,
          ordinal: row.ordinal,
          start: row.start,
          end: row.end,
          startLine: row.start_line,
          endLine: row.end_line,
          headings: JSON.parse(row.headings),
        },
      })
    }
    const limit = args.limit ?? 20
    const hits = [...best.values()].sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri)).slice(0, limit)
    return { hits, strategy: 'vector', warnings: [] }
  }

  status() {
    if (!this.enabled) return { enabled: false }
    const db = this._open()
    return {
      enabled: true,
      model: this.providers.embedModel,
      dimensions: Number(db.prepare("SELECT value FROM meta WHERE key='dimensions'").get()?.value ?? 0) || null,
      chunkVersion: CHUNK_VERSION,
      projectionVersion: PROJECTION_VERSION,
      documents: db.prepare('SELECT count(*) AS n FROM documents').get().n,
      chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
      vectors: db.prepare('SELECT count(*) AS n FROM vectors').get().n,
      inputTokens: db.prepare('SELECT coalesce(sum(tokens), 0) AS n FROM chunks JOIN vectors USING(hash)').get().n,
    }
  }

  close() {
    try { this.db?.close() } catch {}
    this.db = null
  }
}
