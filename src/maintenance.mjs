// Local host curation checkpoint state and bounded change inspection.
// Kept outside the synchronized corpus so multi-device sync never fights over checkpoints.
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'
import { KnowledgeError, TRASH_RETENTION_MS, etag } from './format.mjs'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const invalid = message => new KnowledgeError('INVALID_INPUT', message)

function defaultTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export class KnowledgeMaintenance {
  constructor(store, options = {}) {
    this.store = store
    this.root = path.resolve(
      options.root
      ?? process.env.AGENT_KNOWLEDGE_MAINTENANCE_ROOT
      ?? path.join(path.dirname(store.root), `${path.basename(store.root)}-maintenance`),
    )
    this.now = options.now ?? store.now ?? (() => new Date())
  }

  async checkpoint(name = 'default') {
    if (!NAME.test(name)) throw invalid('Invalid checkpoint name.')
    try {
      const raw = await readFile(path.join(this.root, 'checkpoints', `${name}.json`), 'utf8')
      let value
      try { value = JSON.parse(raw) } catch { throw new KnowledgeError('INVALID_CHECKPOINT', 'Checkpoint JSON is damaged; it was not reset.') }
      if (value.name !== name || !Number.isFinite(Date.parse(value.processedThrough)) || !Number.isInteger(value.version)) {
        throw new KnowledgeError('INVALID_CHECKPOINT', 'Invalid checkpoint; it was not reset.')
      }
      return { ...value, etag: etag(raw) }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { name, processedThrough: null, completedAt: null, version: 0, etag: 'missing', host: hostname() }
      }
      throw error
    }
  }

  async commit({ checkpoint = 'default', through, expectedEtag }) {
    if (!NAME.test(checkpoint)) throw invalid('Invalid checkpoint name.')
    const end = timestamp(through, 'through')
    if (end > this.now().getTime()) throw invalid('Cannot mark future changes as processed.')
    if (!expectedEtag) throw invalid('commit requires expectedEtag from status.')
    const dir = path.join(this.root, 'checkpoints')
    await mkdir(dir, { recursive: true })
    const lock = path.join(dir, `${checkpoint}.lock`)
    const handle = await open(lock, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') {
        throw new KnowledgeError('CHECKPOINT_BUSY', 'Another commit is in progress; retry after it finishes.')
      }
      throw error
    })
    let temporary
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }))
      const current = await this.checkpoint(checkpoint)
      if (current.etag !== expectedEtag) {
        throw new KnowledgeError('ETAG_MISMATCH', 'Checkpoint changed; read status again.', { currentEtag: current.etag })
      }
      if (current.processedThrough && end < Date.parse(current.processedThrough)) {
        throw invalid('Checkpoint cannot move backwards.')
      }
      const value = {
        name: checkpoint,
        processedThrough: new Date(end).toISOString(),
        completedAt: this.now().toISOString(),
        version: current.version + 1,
        host: hostname(),
      }
      const raw = JSON.stringify(value)
      temporary = path.join(dir, `.${checkpoint}.${randomUUID()}.tmp`)
      const writer = await open(temporary, 'wx', 0o600)
      try { await writer.writeFile(raw, 'utf8') } finally { await writer.close() }
      await rename(temporary, path.join(dir, `${checkpoint}.json`))
      return { ...value, etag: etag(raw) }
    } finally {
      if (temporary) await rm(temporary, { force: true })
      await handle.close()
      await rm(lock, { force: true })
    }
  }

  async changes(args = {}) {
    const observedAt = this.now().toISOString()
    const checkpoint = args.checkpoint ? await this.checkpoint(args.checkpoint) : null
    const timeZone = args.timeZone ?? defaultTimeZone()
    let since
    let until
    let after = ''
    if (args.cursor) {
      if (args.since || args.until || args.day) throw invalid('Use cursor alone with the same checkpoint and limit.')
      let cursor
      try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) } catch { throw invalid('Invalid pagination cursor.') }
      if (cursor.version !== 1 || typeof cursor.after !== 'string' || cursor.checkpoint !== (args.checkpoint ?? null)) {
        throw invalid('Invalid pagination cursor.')
      }
      since = cursor.since
      until = cursor.until
      after = cursor.after
    } else if (args.day) {
      if (args.since || args.until || args.checkpoint) throw invalid('day cannot be combined with a range or checkpoint.')
      ;({ since, until } = dayWindow(args.day, timeZone, this.now()))
      until = new Date(Math.min(Date.parse(until), Date.parse(observedAt))).toISOString()
    } else {
      since = args.since ?? checkpoint?.processedThrough ?? (checkpoint ? '1970-01-01T00:00:00.000Z' : dayWindow('today', timeZone, this.now()).since)
      until = args.until ?? observedAt
    }

    const start = timestamp(since, 'since')
    const end = timestamp(until, 'until')
    if (start > end || end > Date.parse(observedAt)) throw invalid('Range must be ordered and must not end in the future.')
    since = new Date(start).toISOString()
    until = new Date(end).toISOString()

    const inside = value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) < end
    const [scanned, trash] = await Promise.all([
      this.store.scan(true),
      this.store.listTrash({ includeExpired: true }),
    ])

    const changes = []
    const undated = []
    for (const doc of scanned.docs) {
      const fm = doc.frontmatter
      if (!Number.isFinite(Date.parse(fm.created)) && !Number.isFinite(Date.parse(fm.updated))) undated.push(doc.uri)
      const kind = inside(fm.created) ? 'created' : inside(fm.updated) ? 'updated' : null
      if (!kind) continue
      changes.push({
        key: `${doc.uri}|active`,
        kind,
        uri: doc.uri,
        readUri: doc.uri,
        type: doc.type,
        name: fm.name,
        description: fm.description ?? '',
        tags: fm.tags,
        created: fm.created ?? null,
        updated: fm.updated ?? null,
        archived: doc.archived,
        etag: doc.etag,
      })
    }

    for (const item of trash.entries) {
      if (!inside(item.deletedAt)) continue
      changes.push({
        key: `${item.uri}|${item.trashUri}`,
        kind: 'deleted',
        uri: item.uri,
        readUri: item.expired ? null : item.trashUri,
        name: item.name,
        type: item.type,
        deletedAt: item.deletedAt,
        expiresAt: item.expiresAt,
        expired: item.expired,
        etag: item.etag,
        ...(item.reason ? { reason: item.reason } : {}),
      })
    }

    changes.sort((a, b) => a.key.localeCompare(b.key))
    const available = changes.filter(change => change.key.localeCompare(after) > 0)
    const limit = args.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('limit must be between 1 and 500.')
    const selected = available.slice(0, limit)
    const truncated = available.length > selected.length

    return {
      view: 'changes',
      observedAt,
      window: { since, until, bounds: '[since, until)' },
      checkpoint,
      changes: selected.map(({ key: _key, ...value }) => value),
      total: changes.length,
      truncated,
      nextCursor: truncated
        ? Buffer.from(JSON.stringify({ version: 1, since, until, after: selected.at(-1).key, checkpoint: args.checkpoint ?? null })).toString('base64url')
        : null,
      counts: Object.fromEntries(['created', 'updated', 'deleted'].map(kind => [kind, changes.filter(item => item.kind === kind).length])),
      undated,
      warnings: [...(scanned.invalidDocuments ?? []), ...(scanned.conflicts ?? []), ...trash.warnings],
      deletionRetentionHours: TRASH_RETENTION_MS / 3600000,
    }
  }
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid(`${field} must be an ISO timestamp with timezone.`)
  }
  return Date.parse(value)
}

function dayWindow(day, timeZone, now) {
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch {
    throw invalid('Invalid timeZone.')
  }
  const parts = date => Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
  if (day === 'today') {
    const p = parts(now)
    day = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  }
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw invalid('day must be today or YYYY-MM-DD.')
  const [year, month, date] = day.split('-').map(Number)
  const base = Date.UTC(year, month - 1, date)
  if (new Date(base).toISOString().slice(0, 10) !== day) throw invalid('Invalid calendar day.')
  const midnight = target => {
    let instant = target
    for (let i = 0; i < 4; i++) {
      const p = parts(new Date(instant))
      const displayed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      const delta = target - displayed
      if (!delta) return new Date(instant).toISOString()
      instant += delta
    }
    throw invalid('Timezone has no resolvable midnight for the requested day.')
  }
  return { since: midnight(base), until: midnight(base + 86400000) }
}
