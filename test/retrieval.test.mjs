import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from '../src/store.mjs'
import { createProviders } from '../src/providers.mjs'
import { sanitizeModelText } from '../src/ranking.mjs'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-retrieval-'))
  const store = new KnowledgeStore({
    root: path.join(dir, 'memory'),
    cacheDir: path.join(dir, 'cache'),
    maintenanceRoot: path.join(dir, 'maint'),
    ...options,
  })
  await store.initialize({ seed: false })
  t.after(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, store }
}

test('SQLite lexical index matches in-memory BM25F parity and handles Chinese queries', async t => {
  const { dir, store: indexedStore } = await fixture(t, { index: true })
  const memoryStore = new KnowledgeStore({
    root: indexedStore.root,
    cacheDir: path.join(dir, 'cache-mem'),
    maintenanceRoot: path.join(dir, 'maint'),
    index: false,
  })
  t.after(() => memoryStore.close())

  await indexedStore.create({
    uri: 'memory://note/title-match',
    name: '向量融合策略',
    tags: ['retrieval'],
    body: 'Using RRF k=60 combines sparse and dense rankings.',
  })
  await indexedStore.create({
    uri: 'memory://note/body-only',
    name: 'Unrelated Note',
    tags: ['misc'],
    body: 'Mentions 向量融合策略 once in body.',
  })

  const r1 = await indexedStore.find({ query: '向量融合策略' })
  const r2 = await memoryStore.find({ query: '向量融合策略' })
  assert.deepEqual(r1.hits.map(h => h.uri), ['memory://note/title-match', 'memory://note/body-only'])
  assert.deepEqual(r1.hits.map(h => h.uri), r2.hits.map(h => h.uri))
  assert.ok(Math.abs(r1.hits[0].score - r2.hits[0].score) < 1e-9)
})

test('optional OpenAI-compatible embeddings + rerank fuse cleanly, sanitize credentials, and fail soft on error', async t => {
  const embedBodies = []
  const rerankBodies = []
  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (String(url).endsWith('/embeddings')) {
      embedBodies.push(body)
      const vecs = body.input.map((text, idx) => ({
        index: idx,
        embedding: text.includes('semantic') ? [1, 0, 0, 0] : [0, 1, 0, 0],
      }))
      return new Response(JSON.stringify({ data: vecs }), { status: 200 })
    }
    if (String(url).endsWith('/rerank')) {
      rerankBodies.push(body)
      // Flip order deliberately to prove reranker signal applies cleanly.
      return new Response(JSON.stringify({
        results: body.documents.map((_, idx) => ({ index: idx, relevance_score: 0.1 + idx * 0.4 })),
      }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }

  const providers = createProviders({
    embedBase: 'https://embed.mock.local/v1',
    embedKey: 'test-key',
    embedModel: 'test-embed',
    rerankBase: 'https://rerank.mock.local/v1',
    rerankKey: 'rerank-key',
    fetch: mockFetch,
  })

  const { store } = await fixture(t, { providers })
  await store.create({
    uri: 'memory://note/semantic-note',
    name: 'Vector Candidate',
    body: 'This note explains semantic architecture design and secret sk-1234567890abcdef token handling.',
  })
  await store.create({
    uri: 'memory://note/lexical-note',
    name: 'meaning lookup basics',
    body: 'Keyword match for meaning lookup guide.',
  })
  await store.create({
    uri: 'memory://identity/private-bio',
    name: 'meaning lookup identity',
    body: 'Identity meaning lookup should never be sent to embedding/rerank models.',
  })

  const hybrid = await store.find({ query: 'semantic lookup' })
  assert.equal(hybrid.strategy, 'hybrid-reranked')
  assert.equal(embedBodies.some(b => JSON.stringify(b.input).includes('Identity')), false)
  assert.equal(rerankBodies.length, 1)
  assert.equal(rerankBodies[0].documents.some(d => d.includes('sk-1234567890abcdef')), false)

  const noRerank = await store.find({ query: 'semantic lookup', rerank: false })
  assert.equal(noRerank.strategy, 'hybrid')
  assert.equal(rerankBodies.length, 1)

  const lexicalOnly = await store.find({ query: 'semantic lookup', retrieval: 'lexical' })
  assert.equal(lexicalOnly.strategy, 'lexical')
  assert.equal(rerankBodies.length, 1)

  const vecStatus = await store.status({ view: 'vectors' })
  assert.equal(vecStatus.enabled, true)
  assert.equal(vecStatus.dimensions, 4)
  assert.equal(vecStatus.documents, 2) // identity excluded from vector index

  const vecOnly = await store.find({ query: 'semantic vector query', retrieval: 'vector' })
  assert.equal(vecOnly.strategy, 'vector')
  assert.equal(vecOnly.hits[0].uri, 'memory://note/semantic-note')

  // Fail-soft circuit test when upstream goes down.
  const brokenProviders = createProviders({
    embedBase: 'https://down.mock.local/v1',
    rerankBase: 'https://down.mock.local/v1',
    fetch: async () => new Response('upstream error', { status: 503 }),
  })
  const { store: brokenStore } = await fixture(t, { providers: brokenProviders })
  await brokenStore.create({ uri: 'memory://note/alpha', name: 'Fallback test', body: 'alpha_token_123' })
  const fallback = await brokenStore.find({ query: 'alpha_token_123', retrieval: 'hybrid', rerank: true })
  assert.equal(fallback.strategy, 'lexical')
  assert.equal(fallback.hits[0].uri, 'memory://note/alpha')
  assert.equal(fallback.warnings.some(w => w.code === 'EMBEDDING_UNAVAILABLE'), true)

  // Sanitization check.
  const cleaned = sanitizeModelText('Authorization: Bearer secret123\nurl: https://host.example/private/secret?k=1\npassword=supersecret')
  assert.doesNotMatch(cleaned, /secret123|\/private\/secret|supersecret/)
})
