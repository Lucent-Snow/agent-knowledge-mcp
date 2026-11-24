import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from '../src/store.mjs'
import { fileFor } from '../src/format.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-skill-'))
  let tick = Date.parse('2026-11-12T00:00:00.000Z')
  const store = new KnowledgeStore({
    root: path.join(dir, 'memory'),
    cacheDir: path.join(dir, 'cache'),
    maintenanceRoot: path.join(dir, 'maint'),
    now: () => new Date(tick += 1000),
  })
  await store.initialize({ seed: false })
  t.after(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { store }
}

test('skill bundles manage SKILL.md plus subfiles, LRU context ordering, and trash bundle restore', async t => {
  const { store } = await fixture(t)

  const created = await store.create({
    uri: 'memory://skill/release-check',
    name: 'Release Check',
    description: 'Run pre-release checks cleanly',
    body: '# Release Check\n\nExecute scripts/check.sh before publishing.',
    files: [
      { path: 'scripts/check.sh', content: '#!/bin/sh\necho ok\n' },
      { path: 'docs/checklist.md', content: '# Checklist\n- Tests\n' },
    ],
  })

  // POSIX scripts automatically receive executable mode.
  if (process.platform !== 'win32') {
    const scriptPath = path.join(path.dirname(fileFor(store.root, 'memory://skill/release-check')), 'scripts/check.sh')
    const mode = (await lstat(scriptPath)).mode & 0o777
    assert.equal(Boolean(mode & 0o100), true)
  }

  // docs/checklist.md inside a skill bundle must not produce invalid-document health errors.
  const health = await store.status({ view: 'health' })
  assert.equal(health.healthy, true)
  assert.equal(health.documents, 1)

  // Create a second ambient skill.
  await store.create({
    uri: 'memory://skill/pinned-guide',
    name: 'Pinned Guide',
    description: 'Always top-ranked ambient skill',
    frontmatter: { ambient: true },
    body: 'Core workflow.',
  })

  // Read main bundle and subfile; update subfile with patch.
  const main = await store.read('memory://skill/release-check')
  assert.deepEqual(main.files, ['docs/checklist.md', 'scripts/check.sh', 'SKILL.md'])
  const sub = await store.read('memory://skill/release-check', { file: 'docs/checklist.md' })
  assert.match(sub.content, /- Tests/)

  await store.edit({
    uri: 'memory://skill/release-check',
    expectedEtag: main.etag,
    file: 'docs/checklist.md',
    op: 'patch',
    oldString: '- Tests',
    newString: '- Tests\n- Pack check',
  })
  const patchedSub = await store.read('memory://skill/release-check', { file: 'docs/checklist.md' })
  assert.match(patchedSub.content, /- Pack check/)

  // Reject path escape on skill files.
  await assert.rejects(
    store.read('memory://skill/release-check', { file: '../outside.txt' }),
    err => err.code === 'INVALID_PATH',
  )

  // Context lists skills cleanly and prioritizes ambient + recently accessed.
  const ctxSkills = await store.context('/skills')
  assert.match(ctxSkills.rendered, /memory:\/\/skill\/release-check/)
  const ctxRecent = await store.context('/skills/recent')
  assert.match(ctxRecent.rendered, /memory:\/\/skill\/pinned-guide/)

  // Delete and restore entire skill bundle via .trash/<uuid>-bundle.
  const latestMain = await store.read('memory://skill/release-check', { recordAccess: false })
  const deleted = await store.delete('memory://skill/release-check', latestMain.etag)
  const trashEntry = await store.loadTrash(deleted.trashUri)
  const restored = await store.restore(deleted.trashUri, trashEntry.etag)
  assert.equal(restored.restored, true)

  const afterRestore = await store.read('memory://skill/release-check')
  assert.deepEqual(afterRestore.files, ['docs/checklist.md', 'scripts/check.sh', 'SKILL.md'])
  const restoredSub = await store.read('memory://skill/release-check', { file: 'docs/checklist.md' })
  assert.match(restoredSub.content, /- Pack check/)
})
