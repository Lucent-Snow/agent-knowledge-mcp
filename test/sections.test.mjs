import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from '../src/store.mjs'
import { HISTORY_END, HISTORY_START, contentRoleAt, memoryProjection, memorySections } from '../src/sections.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-sections-'))
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

test('memorySections parses paired history markers while ignoring fenced code examples', () => {
  const body = [
    '# Current',
    'Active guideline uses alpha protocol.',
    '```markdown',
    HISTORY_START,
    'fenced example tokenonly',
    HISTORY_END,
    '```',
    '',
    HISTORY_START,
    'Historical rationale deprecated_beta_token.',
    HISTORY_END,
    '',
    'Afterward active footnote.',
  ].join('\n')

  const parsed = memorySections(body)
  assert.equal(parsed.warnings.length, 0)
  const projected = memoryProjection(body)
  assert.equal(projected.length, body.length)
  assert.match(projected, /alpha protocol/)
  assert.match(projected, /fenced example tokenonly/)
  assert.doesNotMatch(projected, /deprecated_beta_token/)
  assert.equal(contentRoleAt(body, body.indexOf('alpha protocol')), 'current')
  assert.equal(contentRoleAt(body, body.indexOf('deprecated_beta_token')), 'history')
})

test('store rejects mismatched history markers on create/edit and isolates history from default search/context', async t => {
  const { store } = await fixture(t)

  await assert.rejects(
    store.create({
      uri: 'memory://note/unclosed',
      name: 'Unclosed history',
      body: `${HISTORY_START}\nforgot closing marker`,
    }),
    err => err.code === 'INVALID_CONTENT_SECTIONS',
  )

  const created = await store.create({
    uri: 'memory://context/global/rules',
    name: 'Global Rules',
    body: `Use alpha_guideline in production.\n\n${HISTORY_START}\nOld draft used retired_beta_marker.\n${HISTORY_END}\n`,
  })

  // Context projection excludes history block.
  const ctx = await store.context('/context')
  assert.match(ctx.rendered, /alpha_guideline/)
  assert.doesNotMatch(ctx.rendered, /retired_beta_marker/)

  // Exact read keeps canonical body complete plus section metadata.
  const loaded = await store.read('memory://context/global/rules')
  assert.match(loaded.body, /retired_beta_marker/)
  assert.equal(loaded.contentSections.spans.some(s => s.role === 'history'), true)

  // Default find excludes history, whereas includeHistory finds it with contentRole 'history'.
  const defaultFind = await store.find({ query: 'retired_beta_marker' })
  assert.equal(defaultFind.hits.length, 0)

  const historyFind = await store.find({ query: 'retired_beta_marker', includeHistory: true })
  assert.equal(historyFind.hits.length, 1)
  assert.equal(historyFind.hits[0].contentRole, 'history')

  // Reject unclosed edit.
  await assert.rejects(
    store.edit({
      uri: 'memory://context/global/rules',
      expectedEtag: created.etag,
      op: 'replace',
      body: `${HISTORY_END}\nbad order`,
    }),
    err => err.code === 'INVALID_CONTENT_SECTIONS',
  )
})
