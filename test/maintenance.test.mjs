import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from '../src/store.mjs'
import { archiveFileFor, fileFor } from '../src/format.mjs'

async function fixture(t, clockStart = Date.parse('2026-11-10T10:00:00.000Z')) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-maint-'))
  let currentNow = clockStart
  const store = new KnowledgeStore({
    root: path.join(dir, 'memory'),
    cacheDir: path.join(dir, 'cache'),
    maintenanceRoot: path.join(dir, 'maint'),
    actor: 'curation-bot',
    now: () => new Date(currentNow),
  })
  await store.initialize({ seed: false })
  t.after(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    dir,
    store,
    advanceMs: ms => { currentNow += ms },
  }
}

test('location-based archive moves files without writing archived flag into YAML and detects conflicts', async t => {
  const { store } = await fixture(t)
  const created = await store.create({
    uri: 'memory://note/retire-me',
    name: 'Retire note',
    body: 'Old but keep for audit.',
  })
  assert.equal(created.archived, false)

  const archived = await store.setArchived('memory://note/retire-me', created.etag, true)
  assert.equal(archived.archived, true)
  assert.equal(existsSync(fileFor(store.root, 'memory://note/retire-me')), false)
  assert.equal(existsSync(archiveFileFor(store.root, 'memory://note/retire-me')), true)

  const rawMarkdown = await readFile(archiveFileFor(store.root, 'memory://note/retire-me'), 'utf8')
  assert.doesNotMatch(rawMarkdown, /^archived:/m)
  assert.match(rawMarkdown, /updatedBy: curation-bot/)

  assert.equal((await store.find({ query: 'Retire note' })).hits.length, 0)
  const withArchived = await store.find({ query: 'Retire note', includeArchived: true })
  assert.equal(withArchived.hits.length, 1)
  assert.equal(withArchived.hits[0].archived, true)

  // Unarchive restores to active path.
  const unarchived = await store.setArchived('memory://note/retire-me', archived.etag, false)
  assert.equal(unarchived.archived, false)
  assert.equal(existsSync(fileFor(store.root, 'memory://note/retire-me')), true)

  // Location conflict when both active & archive copies exist.
  await writeFile(archiveFileFor(store.root, 'memory://note/retire-me').replace(/\.md$/, '.md'), rawMarkdown, 'utf8').catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(archiveFileFor(store.root, 'memory://note/retire-me')), { recursive: true })
    await writeFile(archiveFileFor(store.root, 'memory://note/retire-me'), rawMarkdown, 'utf8')
  })
  const health = await store.status({ view: 'health' })
  assert.equal(health.healthy, false)
  assert.equal(health.conflicts.some(c => c.code === 'LOCATION_CONFLICT' && c.uri === 'memory://note/retire-me'), true)
})

test('72-hour trash supports restore without overwriting recreated URI and explicit purge_expired', async t => {
  const { store, advanceMs } = await fixture(t)
  const doc = await store.create({
    uri: 'memory://note/temp',
    name: 'Temp note',
    body: 'Recoverable bytes',
  })

  const deleted = await store.delete('memory://note/temp', doc.etag, 'cleanup')
  assert.equal(deleted.deleted, true)
  assert.match(deleted.trashUri, /^trash:\/\//)

  const trashList = await store.status({ view: 'trash' })
  assert.equal(trashList.entries.length, 1)
  assert.equal(trashList.entries[0].reason, 'cleanup')

  const trashRead = await store.loadTrash(deleted.trashUri)
  assert.equal(trashRead.originalUri, 'memory://note/temp')
  assert.equal(trashRead.body, 'Recoverable bytes')

  // Recreate at the same URI; restore must refuse to overwrite.
  await store.create({ uri: 'memory://note/temp', name: 'Replacement', body: 'New' })
  await assert.rejects(
    store.restore(deleted.trashUri, trashRead.etag),
    err => err.code === 'ALREADY_EXISTS',
  )

  // Expired entry cannot be read or restored, and purge_expired deletes it.
  advanceMs(73 * 60 * 60 * 1000)
  await assert.rejects(store.loadTrash(deleted.trashUri), err => err.code === 'TRASH_EXPIRED')
  const purged = await store.purgeExpiredTrash()
  assert.deepEqual(purged.purged, [deleted.trashUri])
})

test('changes pagination and explicit checkpoint commit follow read-only and CAS rules', async t => {
  const { store, advanceMs } = await fixture(t)

  await store.create({ uri: 'memory://note/c1', name: 'First note', body: 'one' })
  advanceMs(1000)
  await store.create({ uri: 'memory://note/c2', name: 'Second note', body: 'two' })
  advanceMs(1000)
  const third = await store.create({ uri: 'memory://note/c3', name: 'Third note', body: 'three' })
  advanceMs(1000)
  await store.delete('memory://note/c3', third.etag, 'obsolete')
  advanceMs(1000)

  const page1 = await store.status({ view: 'changes', checkpoint: 'nightly', limit: 2 })
  assert.equal(page1.checkpoint.etag, 'missing')
  assert.equal(page1.changes.length, 2)
  assert.equal(page1.truncated, true)
  assert.equal(page1.total, 3)

  const page2 = await store.status({ view: 'changes', checkpoint: 'nightly', limit: 2, cursor: page1.nextCursor })
  assert.equal(page2.changes.length, 1)
  assert.equal(page2.truncated, false)

  // Reading changes did not advance checkpoint.
  assert.equal((await store.status({ view: 'checkpoint', checkpoint: 'nightly' })).checkpoint.etag, 'missing')

  const committed = await store.maintenance.commit({
    checkpoint: 'nightly',
    through: page1.window.until,
    expectedEtag: page1.checkpoint.etag,
  })
  assert.equal(committed.version, 1)
  assert.equal(committed.processedThrough, page1.window.until)

  // Reject stale etag and backward movement.
  await assert.rejects(
    store.maintenance.commit({ checkpoint: 'nightly', through: page1.window.until, expectedEtag: 'missing' }),
    err => err.code === 'ETAG_MISMATCH',
  )
  await assert.rejects(
    store.maintenance.commit({
      checkpoint: 'nightly',
      through: '2026-11-09T00:00:00.000Z',
      expectedEtag: committed.etag,
    }),
    err => err.code === 'INVALID_INPUT',
  )
})
