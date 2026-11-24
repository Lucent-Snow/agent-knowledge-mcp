import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultCacheDir } from './lexical-index.mjs'

export function defaultAccessDbPath(root) {
  return path.join(defaultCacheDir(root), 'access.sqlite')
}

export class AccessStats {
  constructor(dbPath) {
    this.dbPath = dbPath
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(dbPath)
    if (dbPath !== ':memory:') {
      try { chmodSync(dbPath, 0o600) } catch {}
    }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS access_records (
        uri TEXT PRIMARY KEY,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_access_time ON access_records(last_accessed_at);
    `)
  }

  record(uri, at = new Date().toISOString()) {
    try {
      this.db.prepare(`
        INSERT INTO access_records (uri, last_accessed_at, access_count)
        VALUES (?, ?, 1)
        ON CONFLICT(uri) DO UPDATE SET
          last_accessed_at = excluded.last_accessed_at,
          access_count = access_count + 1
      `).run(uri, at)
    } catch {
      // Non-blocking fail-soft metric update
    }
  }

  get(uri) {
    try {
      return this.db.prepare('SELECT last_accessed_at, access_count FROM access_records WHERE uri = ?').get(uri) ?? null
    } catch {
      return null
    }
  }

  all() {
    try {
      return this.db.prepare('SELECT uri, last_accessed_at, access_count FROM access_records ORDER BY last_accessed_at DESC').all()
    } catch {
      return []
    }
  }

  close() {
    try { this.db.close() } catch {}
  }
}
