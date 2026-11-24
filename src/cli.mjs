#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHttpServer } from './http.mjs'
import { createKnowledgeServer } from './server.mjs'
import { KnowledgeStore } from './store.mjs'
import { prepareSync } from './sync.mjs'

const VERSION = '0.2.0'
const HELP = `agent-knowledge-mcp ${VERSION} — portable Markdown memory

Usage:
  agent-knowledge-mcp serve [--transport stdio|http] [options]
  agent-knowledge-mcp init [--root PATH] [--no-seed]
  agent-knowledge-mcp status [--root PATH] [--view health|changes|trash|checkpoint|vectors] [--checkpoint NAME]
  agent-knowledge-mcp sync-prepare [--root PATH]
  agent-knowledge-mcp token --token-file PATH [--root PATH]

Options:
  --root PATH                  Memory directory (default ~/.agent-knowledge)
  --scope NAME                 Context scope for matching Context files
  --actor NAME                 Author identifier recorded as updatedBy (or AGENT_KNOWLEDGE_ACTOR)
  --cache-dir PATH             Local SQLite cache directory outside the corpus
  --maintenance-root PATH      Local curation checkpoint directory outside the corpus
  --no-index                   Disable SQLite lexical cache and use in-memory BM25F
  --no-seed                    Do not create the initial memory guide
  --transport stdio|http       MCP transport (default stdio)
  --host HOST                  HTTP bind host (default 127.0.0.1)
  --port PORT                  HTTP bind port (default 7464)
  --token-file PATH            64-hex credential file with mode 0600 outside the memory root
  --url-token                  Use /mcp/<token> path auth for clients without Bearer headers
  --allowed-host HOSTNAME      Allow a public proxy Host (repeatable)
  --allowed-origin ORIGIN      Allow a browser Origin (repeatable)
  --help / --version
`

async function outsideRoot(file, root) {
  const physicalRoot = await realpath(root).catch(e => { if (e.code === 'ENOENT') return root; throw e })
  const physicalFile = path.join(await realpath(path.dirname(file)), path.basename(file))
  const relative = path.relative(physicalRoot, physicalFile)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Store credentials outside the memory directory.')
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'serve'
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      scope: { type: 'string' },
      actor: { type: 'string' },
      'cache-dir': { type: 'string' },
      'maintenance-root': { type: 'string' },
      'no-index': { type: 'boolean', default: false },
      view: { type: 'string', default: 'health' },
      checkpoint: { type: 'string' },
      'no-seed': { type: 'boolean' },
      transport: { type: 'string', default: 'stdio' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '7464' },
      'token-file': { type: 'string' },
      'url-token': { type: 'boolean' },
      'allowed-host': { type: 'string', multiple: true, default: [] },
      'allowed-origin': { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.help || command === 'help') { console.log(HELP); return }
  if (values.version) { console.log(VERSION); return }
  if (!['serve', 'init', 'status', 'sync-prepare', 'token'].includes(command)) {
    throw new Error(`Unknown command: ${command}`)
  }

  if (command === 'token') {
    if (!values['token-file']) throw new Error('token requires --token-file PATH outside the memory root.')
    const file = path.resolve(values['token-file'])
    const root = new KnowledgeStore({ root: values.root }).root
    const relative = path.relative(root, file)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('Store credentials outside the memory directory.')
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await outsideRoot(file, root)
    await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
    console.log(`Credential created at ${file}. Keep it private.`)
    return
  }

  const store = new KnowledgeStore({
    root: values.root,
    scope: values.scope,
    actor: values.actor,
    cacheDir: values['cache-dir'],
    maintenanceRoot: values['maintenance-root'],
    index: !values['no-index'],
  })

  if (command === 'status') {
    try {
      const result = await store.status({ view: values.view, checkpoint: values.checkpoint })
      console.log(JSON.stringify(result, null, 2))
      if (values.view === 'health' && !result.healthy) process.exitCode = 1
    } finally {
      store.close()
    }
    return
  }

  if (command === 'sync-prepare') {
    try {
      console.log(JSON.stringify(await prepareSync(store), null, 2))
    } finally {
      store.close()
    }
    return
  }

  if (command === 'init') {
    try {
      console.log(JSON.stringify(await store.initialize({ seed: !values['no-seed'], explicit: true }), null, 2))
    } finally {
      store.close()
    }
    return
  }

  if (!['stdio', 'http'].includes(values.transport)) throw new Error('transport must be stdio or http.')

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
    httpOptions = {
      store,
      token,
      urlToken: values['url-token'],
      port,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...values['allowed-host']],
      allowedOrigins: values['allowed-origin'],
    }
  }

  await store.initialize({ seed: !values['no-seed'] })
  if (values.transport === 'stdio') {
    const shutdown = () => { store.close(); process.exit(0) }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    const server = createKnowledgeServer(store)
    await server.connect(new StdioServerTransport())
  } else {
    const http = createHttpServer(httpOptions)
    http.on('error', error => { console.error('HTTP listener failed:', error.code ?? error.name); process.exitCode = 1 })
    http.listen(httpOptions.port, values.host, () => {
      console.error(`HTTP MCP listening on ${values.host}:${httpOptions.port}. Endpoint: ${values['url-token'] ? '/mcp/<credential>' : '/mcp'}.`)
    })
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        http.close()
        http.closeAllConnections()
        store.close()
      })
    }
  }
}

main().catch(error => {
  console.error(`${error.code ?? 'ERROR'}: ${error.message}`)
  process.exitCode = 1
})
