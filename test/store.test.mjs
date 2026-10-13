import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { KnowledgeStore } from '../src/store.mjs'
import { parseUri, SEED_URI, parseDocument } from '../src/format.mjs'
import { prepareSync } from '../src/sync.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new KnowledgeStore({ root, ...options })
  await store.initialize()
  return store
}

test('portable URIs reject traversal, conflict names and Windows reserved names', () => {
  for (const uri of ['memory://note/../outside', 'memory://note/a//b', 'memory://note/a.', 'memory://note/con', 'memory://note/AUX.txt', 'memory://note/x.sync-conflict-2026', 'note://x', 'memory://note/中文']) assert.throws(() => parseUri(uri))
  assert.equal(parseUri('memory://note/topic/sub-topic').type, 'note')
})

test('first run seeds one real guide; initialization preserves edits and skipped/deleted seeds', async t => {
  const store = await fixture(t)
  assert.equal((await store.status()).documents, 1)
  const seed = await store.read(SEED_URI)
  await store.edit({ uri: SEED_URI, expectedEtag: seed.etag, op: 'replace', body: 'my own guide' })
  assert.equal((await store.initialize({ explicit: true })).seeded, false)
  assert.equal((await store.read(SEED_URI)).body, 'my own guide')
  const current = await store.read(SEED_URI)
  await store.delete(SEED_URI, current.etag)
  await store.initialize()
  await assert.rejects(store.read(SEED_URI), { code: 'NOT_FOUND' })
  assert.equal((await store.initialize({ explicit: true })).seeded, true)
})

test('no-seed remains empty on subsequent startup; existing library is not modified on startup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'knowledge-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new KnowledgeStore({ root })
  await store.initialize({ seed: false })
  await store.initialize()
  assert.equal((await store.status()).documents, 0)
  await store.create({ uri: 'memory://note/existing', name: 'existing' })
  await rm(path.join(root, '.agent-knowledge.json'))
  await store.initialize()
  assert.equal((await store.status()).documents, 1)
})

test('CRUD preserves etags, exact patch semantics, metadata and archive filtering', async t => {
  const store = await fixture(t)
  const uri = 'memory://project/example'
  await assert.rejects(store.create({ uri, name: 'missing description' }), { code: 'INVALID_DOCUMENT' })
  await store.create({ uri, name: 'Example', description: 'sample project', body: 'same same' })
  await assert.rejects(store.create({ uri, name: 'duplicate', description: 'x' }), { code: 'ALREADY_EXISTS' })
  const original = await store.read(uri)
  await assert.rejects(store.edit({ uri, op: 'replace', body: 'no etag' }), { code: 'INVALID_INPUT' })
  await assert.rejects(store.edit({ uri, op: 'patch', oldString: 'same', newString: 'x', expectedEtag: original.etag }), { code: 'AMBIGUOUS_MATCH' })
  await store.edit({ uri, op: 'patch', oldString: 'same', newString: '$&', replaceAll: true, expectedEtag: original.etag })
  const next = await store.read(uri)
  assert.equal(next.body, '$& $&')
  assert.equal(next.frontmatter.version, 2)
  await assert.rejects(store.delete(uri, original.etag), { code: 'ETAG_MISMATCH' })
  await store.edit({ uri, op: 'append', append: 'more', expectedEtag: next.etag, frontmatter: { archived: true, version: 99, uri: 'wrong' } })
  const archived = await store.read(uri)
  assert.equal(archived.frontmatter.version, 3)
  assert.equal(archived.body, '$& $&\nmore')
  assert.ok(!(await store.find({ query: 'sample project' })).hits.some(hit => hit.uri === uri))
  assert.equal((await store.find({ query: 'sample project', includeArchived: true })).hits[0].uri, uri)
  await store.delete(uri, archived.etag)
  await assert.rejects(store.read(uri), { code: 'NOT_FOUND' })
})

test('Chinese lexical search and bilingual content need no network', async t => {
  const store = await fixture(t)
  await store.create({ uri: 'memory://note/sync', name: '多端同步 Memory replication', description: '让两台电脑共享记忆', body: 'Offline memory replication', tags: ['sync'] })
  assert.equal((await store.find({ query: '电脑共享记忆', tags: ['sync'] })).hits[0].uri, 'memory://note/sync')
  assert.equal((await store.find({ query: 'replication' })).hits[0].uri, 'memory://note/sync')
  assert.equal((await store.find({ query: 'zzzzzznomatch' })).hits.length, 0)
})

test('default context excludes Identity, Notes and project bodies; selects scoped Context and bounds output', async t => {
  const store = await fixture(t, { scope: 'laptop' })
  await store.create({ uri: 'memory://identity/person', name: 'Private profile', body: 'IDENTITY_SECRET' })
  await store.create({ uri: 'memory://note/lesson', name: 'Lesson', body: 'NOTE_SECRET' })
  await store.create({ uri: 'memory://project/current', name: 'Current project', description: 'Working on memory', body: 'PROJECT_BODY_SECRET' })
  await store.create({ uri: 'memory://context/device/laptop', name: 'Laptop', body: 'LAPTOP_CONTEXT', frontmatter: { scope: 'laptop' } })
  await store.create({ uri: 'memory://context/global/manual', name: 'Manual', body: 'MANUAL_SECRET', frontmatter: { ambient: false } })
  const before = (await store.read(SEED_URI)).etag
  const context = await store.context()
  assert.match(context.rendered, /LAPTOP_CONTEXT/)
  assert.match(context.rendered, /Working on memory/)
  for (const secret of ['IDENTITY_SECRET', 'NOTE_SECRET', 'PROJECT_BODY_SECRET', 'MANUAL_SECRET']) assert.ok(!context.rendered.includes(secret))
  assert.match((await store.context('/identity')).rendered, /IDENTITY_SECRET/)
  assert.equal((await store.read(SEED_URI)).etag, before)
  store.contextMaxChars = 500
  const limited = await store.context()
  assert.ok(limited.rendered.length <= 500)
  assert.ok(limited.truncated)
})

test('relations are separate; invalid frontmatter and conflict copies are diagnosed and excluded', async t => {
  const store = await fixture(t)
  await store.create({ uri: 'memory://note/linked', name: 'Linked', body: 'canonical body', links: [{ kind: 'explains', to: SEED_URI }] })
  const guide = await store.read(SEED_URI)
  assert.equal(guide.relations.incoming[0].from, 'memory://note/linked')
  assert.equal((await store.read('memory://note/linked')).body, 'canonical body')
  await writeFile(path.join(store.root, 'note', 'broken.md'), '---\nname: 42\n---\ninvalid metadata')
  await writeFile(path.join(store.root, 'note', 'linked.sync-conflict-20260101-device.md'), 'conflicting text')
  const status = await store.status()
  assert.equal(status.healthy, false)
  assert.equal(status.invalidDocuments.length, 1)
  assert.equal(status.conflicts.length, 1)
  assert.equal((await store.find()).total, 2)
  await assert.rejects(store.read('memory://note/broken'), { code: 'INVALID_DOCUMENT' })
})

test('CRLF Markdown validates identically and malformed YAML fails', () => {
  assert.equal(parseDocument('---\r\nname: Example\r\n---\r\nbody', 'memory://note/example').body, 'body')
  assert.throws(() => parseDocument('---\nname: x\nname: y\n---\nbody', 'memory://note/example'))
})

test('symlinks cannot redirect reads or writes outside the corpus', { skip: process.platform === 'win32' }, async t => {
  const store = await fixture(t)
  const outside = await mkdtemp(path.join(tmpdir(), 'knowledge-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'secret.md'), 'untouched')
  await symlink(outside, path.join(store.root, 'note', 'escape'))
  await assert.rejects(store.create({ uri: 'memory://note/escape/secret', name: 'attack' }), { code: 'UNSAFE_PATH' })
  await assert.rejects(store.read('memory://note/escape/secret'), { code: 'UNSAFE_PATH' })
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), 'untouched')
  assert.equal((await store.status()).invalidDocuments[0].code, 'UNSAFE_PATH')
})

test('concurrent updates from independent Node processes reject one stale writer', async t => {
  const store = await fixture(t)
  const uri = 'memory://project/concurrent'
  await store.create({ uri, name: 'Concurrent', description: 'two writers', body: 'initial' })
  const { etag } = await store.read(uri)
  const moduleUrl = new URL('../src/store.mjs', import.meta.url).href
  const worker = body => new Promise((resolve, reject) => {
    const code = `import {KnowledgeStore} from ${JSON.stringify(moduleUrl)}; const s=new KnowledgeStore({root:process.argv[1]}); try {await s.edit({uri:process.argv[2],expectedEtag:process.argv[3],op:'replace',body:process.argv[4]}); console.log('updated')} catch(e) {console.log(e.code)}`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, store.root, uri, etag, body])
    let out = '', err = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
    child.on('error', reject); child.on('close', code => code ? reject(new Error(err)) : resolve(out.trim()))
  })
  assert.deepEqual((await Promise.all([worker('first'), worker('second')])).sort(), ['ETAG_MISMATCH', 'updated'])
  assert.equal((await store.read(uri)).frontmatter.version, 2)
})

test('concurrent update/delete serialize and one rejects a stale etag', async t => {
  const store = await fixture(t)
  const uri = 'memory://note/race'
  await store.create({ uri, name: 'Race' })
  const { etag } = await store.read(uri)
  const results = await Promise.allSettled([store.edit({ uri, expectedEtag: etag, op: 'replace', body: 'new' }), store.delete(uri, etag)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(['NOT_FOUND', 'ETAG_MISMATCH'].includes(results.find(r => r.status === 'rejected').reason.code))
})

test('sync preparation preserves custom rules and is idempotent', async t => {
  const store = await fixture(t)
  const file = path.join(store.root, '.stignore')
  await writeFile(file, '/note/private/**\n')
  await prepareSync(store)
  const first = await readFile(file, 'utf8')
  await prepareSync(store)
  assert.equal(await readFile(file, 'utf8'), first)
  assert.ok(first.startsWith('/note/private/**'))
  assert.ok(first.includes('!/note/**'))
  assert.ok(!first.includes('*.sync-conflict-'))
})
