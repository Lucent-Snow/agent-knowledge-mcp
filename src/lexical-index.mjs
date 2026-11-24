// Disposable SQLite BM25F full-text index. Never owns canonical memory or
// maintenance checkpoints. Scoring matches in-memory BM25Index(bigrams).
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BM25_WEIGHTS, RANKING_DEFAULTS, rankingFields, rankingTokens } from './ranking.mjs'
import { PROJECTION_VERSION, memoryProjection } from './sections.mjs'

const SCHEMA_VERSION = 'bigram-bm25f-mcp-2'

function removeDbFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
}

export function defaultCacheDir(root) {
  let base = process.env.AGENT_KNOWLEDGE_CACHE_DIR
  if (!base) {
    base = process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, 'agent-knowledge-mcp')
      : path.join(homedir(), '.cache', 'agent-knowledge-mcp')
  }
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)
  return path.join(base, hash)
}

export class LexicalIndex {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      this.db = new DatabaseSync(file)
    } catch {
      if (file === ':memory:') throw new Error('Failed to open in-memory SQLite database')
      removeDbFiles(file)
      this.db = new DatabaseSync(file)
    }
    if (file !== ':memory:') {
      try { chmodSync(file, 0o600) } catch {}
    }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs(
        uri TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        archived INTEGER NOT NULL,
        tags TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        metadata TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lengths(
        uri TEXT NOT NULL REFERENCES docs(uri) ON DELETE CASCADE,
        field TEXT NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY(uri, field)
      );
      CREATE TABLE IF NOT EXISTS terms(
        term TEXT NOT NULL,
        uri TEXT NOT NULL REFERENCES docs(uri) ON DELETE CASCADE,
        field TEXT NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY(term, uri, field)
      );
      CREATE INDEX IF NOT EXISTS docs_filter ON docs(type, archived, status);
      CREATE INDEX IF NOT EXISTS terms_uri ON terms(uri);
    `)
    const saved = this.db.prepare("SELECT value FROM manifest WHERE key='schema'").get()?.value
    if (saved && saved !== SCHEMA_VERSION) {
      if (file === ':memory:') throw new Error('Lexical index schema mismatch')
      this.db.close()
      removeDbFiles(file)
      return new LexicalIndex(file)
    }
    if (!saved) {
      this.db.prepare("INSERT INTO manifest VALUES('schema', ?)").run(SCHEMA_VERSION)
      this.db.prepare("INSERT OR REPLACE INTO manifest VALUES('projection', ?)").run(PROJECTION_VERSION)
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  catalog() {
    return new Map(this.db.prepare('SELECT uri, fingerprint FROM docs').all().map(row => [row.uri, row.fingerprint]))
  }

  fingerprint(uri) {
    return this.db.prepare('SELECT fingerprint FROM docs WHERE uri=?').get(uri)?.fingerprint
  }

  get(uri) {
    const row = this.db.prepare('SELECT metadata, body FROM docs WHERE uri=?').get(uri)
    return row ? { ...JSON.parse(row.metadata), body: row.body } : null
  }

  put(doc, fingerprint) {
    const projectedBody = memoryProjection(doc.body ?? '')
    const fullFingerprint = `${PROJECTION_VERSION}:${fingerprint}`
    if (this.fingerprint(doc.uri) === fullFingerprint) return false

    const indexedDoc = { ...doc, body: projectedBody }
    const { body: _rawBody, excerpt: _excerpt, filePath: _filePath, ...metadata } = doc
    const indexed = Object.entries(rankingFields(indexedDoc)).map(([field, text]) => {
      const tokens = rankingTokens(text)
      const counts = new Map()
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
      return { field, n: tokens.length, counts }
    })

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO docs VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uri) DO UPDATE SET
          type=excluded.type, status=excluded.status, archived=excluded.archived,
          tags=excluded.tags, fingerprint=excluded.fingerprint,
          metadata=excluded.metadata, body=excluded.body
      `).run(
        doc.uri,
        doc.type,
        doc.status ?? doc.frontmatter?.status ?? '',
        doc.archived === true ? 1 : 0,
        JSON.stringify(doc.tags ?? doc.frontmatter?.tags ?? []),
        fullFingerprint,
        JSON.stringify(metadata),
        projectedBody,
      )
      this.db.prepare('DELETE FROM lengths WHERE uri=?').run(doc.uri)
      this.db.prepare('DELETE FROM terms WHERE uri=?').run(doc.uri)
      const insertLen = this.db.prepare('INSERT INTO lengths VALUES(?, ?, ?)')
      const insertTerm = this.db.prepare('INSERT INTO terms VALUES(?, ?, ?, ?)')
      for (const item of indexed) {
        insertLen.run(doc.uri, item.field, item.n)
        for (const [token, count] of item.counts) insertTerm.run(token, doc.uri, item.field, count)
      }
    })
    return true
  }

  remove(uri) {
    this.db.prepare('DELETE FROM docs WHERE uri=?').run(uri)
  }

  scope({ type, status, includeArchived = false, tags, uris, project, includeSubnotes = true } = {}) {
    const clauses = []
    const args = []
    if (!includeArchived) clauses.push('d.archived=0')
    if (type !== undefined) { clauses.push('d.type=?'); args.push(type) }
    if (status !== undefined) { clauses.push('d.status=?'); args.push(status) }
    if (project) {
      clauses.push('(d.uri=? OR substr(d.uri, 1, length(?))=?)')
      args.push(`memory://project/${project}`, `memory://project/${project}/`, `memory://project/${project}/`)
    } else if (!includeSubnotes) {
      clauses.push("NOT (d.type='project' AND instr(substr(d.uri, 18), '/')>0)")
    }
    for (const tag of tags ?? []) {
      clauses.push('EXISTS(SELECT 1 FROM json_each(d.tags) WHERE value=?)')
      args.push(tag)
    }
    if (uris) {
      clauses.push('d.uri IN (SELECT value FROM json_each(?))')
      args.push(JSON.stringify(uris))
    }
    return { where: clauses.length ? clauses.join(' AND ') : '1', args }
  }

  rank(query, options = {}, limit = 40) {
    const tokens = [...new Set(rankingTokens(query))]
    if (tokens.length > 256) throw new RangeError('Query has too many search terms')
    if (!tokens.length) return []
    const { where, args } = this.scope(options)
    this.db.exec('BEGIN')
    try {
      const n = this.db.prepare(`SELECT count(*) AS n FROM docs d WHERE ${where}`).get(...args).n
      const averages = Object.fromEntries(
        this.db.prepare(`SELECT l.field, avg(l.n) AS mean FROM lengths l JOIN docs d USING(uri) WHERE ${where} AND l.n>0 GROUP BY l.field`)
          .all(...args)
          .map(r => [r.field, r.mean]),
      )
      const placeholders = tokens.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT t.term, t.uri, t.field, t.tf, l.n
        FROM terms t
        JOIN docs d ON d.uri=t.uri
        JOIN lengths l ON l.uri=t.uri AND l.field=t.field
        WHERE ${where} AND t.term IN (${placeholders})
      `).all(...args, ...tokens)

      const byTerm = new Map()
      for (const row of rows) {
        if (!byTerm.has(row.term)) byTerm.set(row.term, new Map())
        const docs = byTerm.get(row.term)
        const normalized = BM25_WEIGHTS[row.field] * row.tf / (1 - RANKING_DEFAULTS.b + RANKING_DEFAULTS.b * row.n / (averages[row.field] || 1))
        docs.set(row.uri, (docs.get(row.uri) ?? 0) + normalized)
      }

      const scores = new Map()
      for (const token of tokens) {
        const docs = byTerm.get(token)
        if (!docs) continue
        const idf = Math.log(1 + (n - docs.size + 0.5) / (docs.size + 0.5))
        for (const [uri, tf] of docs) {
          scores.set(uri, (scores.get(uri) ?? 0) + idf * tf * (RANKING_DEFAULTS.k1 + 1) / (tf + RANKING_DEFAULTS.k1))
        }
      }

      return [...scores]
        .map(([uri, score]) => ({ uri, score }))
        .sort((a, b) => b.score - a.score || a.uri.localeCompare(b.uri))
        .slice(0, limit)
    } finally {
      this.db.exec('COMMIT')
    }
  }

  close() {
    try { this.db.close() } catch {}
  }
}
