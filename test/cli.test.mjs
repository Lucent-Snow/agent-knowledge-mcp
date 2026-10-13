import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const cli = path.resolve('src/cli.mjs')
const run = (...args) => exec(process.execPath, [cli, ...args])

test('CLI init, status, sync preparation and token commands work without revealing credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowledge-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'memory'), token = path.join(dir, 'private', 'mcp.token')
  const initialized = JSON.parse((await run('init', '--root', root)).stdout)
  assert.equal(initialized.seeded, true)
  assert.equal(JSON.parse((await run('status', '--root', root)).stdout).documents, 1)
  await run('sync-prepare', '--root', root)
  const created = await run('token', '--root', root, '--token-file', token)
  const secret = (await readFile(token, 'utf8')).trim()
  assert.match(secret, /^[a-f0-9]{64}$/)
  assert.ok(!created.stdout.includes(secret))
  assert.ok(!created.stderr.includes(secret))
  if (process.platform !== 'win32') assert.equal((await lstat(token)).mode & 0o777, 0o600)
  await assert.rejects(run('token', '--root', root, '--token-file', token))
  assert.equal((await readFile(token, 'utf8')).trim(), secret)
  await assert.rejects(run('token', '--root', root, '--token-file', path.join(root, 'note', 'secret.token')))
  await assert.rejects(run('serve', '--root', root, '--transport', 'http'))
  await assert.rejects(run('serve', '--root', root, '--transport', 'http', '--token-file', token, '--port', '99999'))
  assert.match((await run('--help')).stdout, /sync-prepare/)
  assert.equal((await run('--version')).stdout.trim(), '0.1.0')
})
