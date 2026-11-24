import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from '../src/store.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-hierarchy-'))
  const store = new KnowledgeStore({
    root: path.join(dir, 'memory'),
    cacheDir: path.join(dir, 'cache'),
    maintenanceRoot: path.join(dir, 'maint'),
  })
  await store.initialize({ seed: false })
  t.after(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { store }
}

test('project sub-notes stay isolated globally, appear via project scope and top-level project children', async t => {
  const { store } = await fixture(t)

  await store.create({
    uri: 'memory://project/alpha',
    name: 'Project Alpha',
    description: 'Main tracking hub for Alpha',
    body: 'Alpha overview decision.',
  })
  await store.create({
    uri: 'memory://project/alpha/api-spec',
    name: 'Alpha API Spec',
    description: 'Detailed REST schema for Alpha endpoints',
    body: 'Subnote unique keyword zephyr_endpoint_v2.',
  })
  const retiredSub = await store.create({
    uri: 'memory://project/alpha/old-plan',
    name: 'Alpha Old Plan',
    description: 'Archived draft',
    body: 'Retired subnote.',
  })
  await store.setArchived('memory://project/alpha/old-plan', retiredSub.etag, true)

  await store.create({
    uri: 'memory://project/beta',
    name: 'Project Beta',
    description: 'Unrelated project',
    body: 'Beta overview.',
  })

  // Context /projects/recent excludes sub-notes.
  const ctx = await store.context('/projects/recent')
  assert.match(ctx.rendered, /memory:\/\/project\/alpha\b/)
  assert.match(ctx.rendered, /memory:\/\/project\/beta\b/)
  assert.doesNotMatch(ctx.rendered, /api-spec/)

  // Reading top-level project includes active children only.
  const readAlpha = await store.read('memory://project/alpha')
  assert.equal(readAlpha.children.length, 1)
  assert.equal(readAlpha.children[0].uri, 'memory://project/alpha/api-spec')

  // Global browse and search exclude sub-notes by default.
  const globalBrowse = await store.find({})
  assert.deepEqual(globalBrowse.hits.map(h => h.uri), ['memory://project/alpha', 'memory://project/beta'])

  const globalQuery = await store.find({ query: 'zephyr_endpoint_v2' })
  assert.equal(globalQuery.hits.length, 0)

  // Scoped project search includes project and its sub-notes (without Beta).
  const scopedQuery = await store.find({ project: 'alpha', query: 'zephyr_endpoint_v2' })
  assert.equal(scopedQuery.hits.length, 1)
  assert.equal(scopedQuery.hits[0].uri, 'memory://project/alpha/api-spec')

  const scopedBrowse = await store.find({ project: 'memory://project/alpha' })
  assert.deepEqual(scopedBrowse.hits.map(h => h.uri), ['memory://project/alpha', 'memory://project/alpha/api-spec'])

  // Explicit includeSubnotes: true exposes all sub-notes globally.
  const globalWithSub = await store.find({ query: 'zephyr_endpoint_v2', includeSubnotes: true })
  assert.equal(globalWithSub.hits.length, 1)

  // Reject combining project filter with non-project type.
  await assert.rejects(
    store.find({ project: 'alpha', type: 'note' }),
    err => err.code === 'INVALID_INPUT',
  )
})
