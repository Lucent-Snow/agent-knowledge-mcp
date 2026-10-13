#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { KnowledgeStore } from './store.mjs'
import { createKnowledgeServer } from './server.mjs'
import { createHttpServer } from './http.mjs'
import { prepareSync } from './sync.mjs'

const HELP = `agent-knowledge-mcp 0.1.0 — portable Markdown memory

Commands:
  serve          Start MCP (default); first run initializes a fresh library
  init           Create directories and a missing usage guide; never overwrite
  status         Inspect invalid documents and sync conflicts
  sync-prepare   Generate per-device Syncthing ignore rules (no daemon installed)
  token          Generate an HTTP credential in --token-file (never prints it)

Options:
  --root PATH                 Memory directory (default ~/.agent-knowledge)
  --scope NAME                Device/context scope
  --no-seed                   Skip initial usage guide
  --transport stdio|http      Default stdio
  --host ADDRESS              HTTP bind address (default 127.0.0.1)
  --port NUMBER               HTTP port (default 7464)
  --token-file PATH           Required for HTTP and token command
  --url-token                 Put credential in URL for URL-only clients
  --allowed-host HOSTNAME      Allow a public proxy Host (repeatable)
  --allowed-origin ORIGIN      Allow a browser Origin (repeatable)
  --help / --version
`

async function outsideRoot(file, root) {
  const physicalRoot = await realpath(root).catch(e => { if (e.code === 'ENOENT') return root; throw e })
  const physicalFile = path.join(await realpath(path.dirname(file)), path.basename(file))
  const relative = path.relative(physicalRoot, physicalFile)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Store credentials outside the memory directory.')
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'serve'
  const { values } = parseArgs({ args: argv, options: {
    root: { type: 'string' }, scope: { type: 'string' }, 'no-seed': { type: 'boolean' },
    transport: { type: 'string', default: 'stdio' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '7464' },
    'token-file': { type: 'string' }, 'url-token': { type: 'boolean' },
    'allowed-host': { type: 'string', multiple: true, default: [] }, 'allowed-origin': { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean' }, version: { type: 'boolean' },
  } })
  if (values.help || command === 'help') { console.log(HELP); return }
  if (values.version) { console.log('0.1.0'); return }
  if (!['serve', 'init', 'status', 'sync-prepare', 'token'].includes(command)) throw new Error(`Unknown command: ${command}`)
  if (command === 'token') {
    if (!values['token-file']) throw new Error('token requires --token-file PATH outside the memory root.')
    const file = path.resolve(values['token-file'])
    const root = new KnowledgeStore({ root: values.root }).root
    const relative = path.relative(root, file)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Store credentials outside the memory directory.')
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await outsideRoot(file, root)
    await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
    console.log(`Credential created at ${file}. Keep it private.`)
    return
  }
  const store = new KnowledgeStore({ root: values.root, scope: values.scope })
  if (command === 'status') { console.log(JSON.stringify(await store.status(), null, 2)); return }
  if (command === 'sync-prepare') { console.log(JSON.stringify(await prepareSync(store), null, 2)); return }
  if (command === 'init') { console.log(JSON.stringify(await store.initialize({ seed: !values['no-seed'], explicit: true }), null, 2)); return }
  if (!['stdio', 'http'].includes(values.transport)) throw new Error('transport must be stdio or http.')
  // Check HTTP settings before creating any corpus files.
  let httpOptions
  if (values.transport === 'http') {
    if (!values['token-file']) throw new Error('HTTP requires --token-file; run the token command first.')
    const file = path.resolve(values['token-file'])
    await outsideRoot(file, store.root)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('token-file must be a regular file.')
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('token-file must have mode 0600.')
    const token = (await readFile(file, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid HTTP token file.')
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535.')
    httpOptions = { store, token, urlToken: values['url-token'], port, allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...values['allowed-host']], allowedOrigins: values['allowed-origin'] }
  }
  await store.initialize({ seed: !values['no-seed'] })
  if (values.transport === 'stdio') {
    const server = createKnowledgeServer(store)
    await server.connect(new StdioServerTransport())
  } else {
    const http = createHttpServer(httpOptions)
    http.on('error', error => { console.error('HTTP listener failed:', error.code ?? error.name); process.exitCode = 1 })
    http.listen(httpOptions.port, values.host, () => console.error(`HTTP MCP listening on ${values.host}:${httpOptions.port}. Endpoint: ${values['url-token'] ? '/mcp/<credential>' : '/mcp'}.`))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { http.close(); http.closeAllConnections() })
  }
}

main().catch(error => { console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1 })
