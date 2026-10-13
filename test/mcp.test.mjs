import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { KnowledgeStore } from '../src/store.mjs'
import { createHttpServer } from '../src/http.mjs'
import { SEED_URI } from '../src/format.mjs'

const expectedTools = ['knowledge_context', 'knowledge_delete', 'knowledge_find', 'knowledge_read', 'knowledge_status', 'knowledge_write']
const cli = path.resolve('src/cli.mjs')
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { ...r, value: r.structuredContent }
}
async function connectStdio(root) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--root', root] }))
  return client
}

test('real stdio MCP initializes, persists across sessions, updates and deletes with etag protection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-mcp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let client = await connectStdio(root)
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), expectedTools)
    assert.match((await call(client, 'knowledge_context')).value.rendered, /Memory usage guide/)
    const uri = 'memory://project/demo'
    await call(client, 'knowledge_write', { mode: 'create', uri, name: 'Demo', description: '先支持本地使用', body: 'Local first' })
    await client.close()
    client = await connectStdio(root)
    assert.equal((await call(client, 'knowledge_find', { query: '本地使用' })).value.hits[0].uri, uri)
    const original = (await call(client, 'knowledge_read', { uri })).value
    await call(client, 'knowledge_write', { mode: 'update', uri, op: 'replace', body: 'Remote next', expectedEtag: original.etag })
    const stale = await call(client, 'knowledge_write', { mode: 'update', uri, op: 'replace', body: 'lost', expectedEtag: original.etag })
    assert.equal(stale.isError, true)
    assert.equal(stale.value.error.code, 'ETAG_MISMATCH')
    const latest = (await call(client, 'knowledge_read', { uri })).value
    assert.equal(latest.body, 'Remote next')
    assert.equal(Object.hasOwn(latest, 'filePath'), false)
    assert.equal((await call(client, 'knowledge_delete', { uri, expectedEtag: latest.etag })).value.deleted, true)
    assert.equal((await call(client, 'knowledge_status')).value.documents, 1)
    assert.equal((await call(client, 'knowledge_read', { uri: SEED_URI })).value.frontmatter.version, 1)
  } finally { await client.close() }
})

async function httpFixture(t, urlToken = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-http-'))
  const store = new KnowledgeStore({ root }); await store.initialize()
  const token = 'a'.repeat(64)
  const server = createHttpServer({ store, token, urlToken })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { token, base, endpoint: `${base}/mcp${urlToken ? '/' + token : ''}` }
}

test('remote HTTP MCP supports real SDK handshake and all six tools with bearer authentication', async t => {
  const { token, base, endpoint } = await httpFixture(t)
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status, 403)
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(hostileHostStatus, 403)
  assert.equal((await fetch(base + '/other', { method: 'POST' })).status, 404)
  const client = new Client({ name: 'http-test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), expectedTools)
    const uri = 'memory://note/remote'
    await call(client, 'knowledge_write', { mode: 'create', uri, name: 'Remote test', body: 'remote body' })
    assert.equal((await call(client, 'knowledge_find', { query: 'Remote test' })).value.hits[0].uri, uri)
    const doc = (await call(client, 'knowledge_read', { uri })).value
    await call(client, 'knowledge_write', { mode: 'update', uri, op: 'append', append: 'updated', expectedEtag: doc.etag })
    const updated = (await call(client, 'knowledge_read', { uri })).value
    assert.equal(updated.frontmatter.version, 2)
    assert.match((await call(client, 'knowledge_context')).value.rendered, /usage guide/)
    assert.equal((await call(client, 'knowledge_delete', { uri, expectedEtag: updated.etag })).value.deleted, true)
    assert.equal((await call(client, 'knowledge_status')).value.healthy, true)
  } finally { await client.close() }
})

test('URL-only HTTP credentials work and unknown credentials fail', async t => {
  const { base, endpoint } = await httpFixture(t, true)
  assert.equal((await fetch(base + '/mcp/' + 'b'.repeat(64), { method: 'POST' })).status, 404)
  const client = new Client({ name: 'url-test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
    assert.equal((await call(client, 'knowledge_status')).value.documents, 1)
  } finally { await client.close() }
})
