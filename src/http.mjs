import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createKnowledgeServer } from './server.mjs'

const same = (received, expected) => {
  const a = Buffer.from(received), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createHttpServer({ store, token, urlToken = false, allowedHosts = ['localhost', '127.0.0.1', '[::1]'], allowedOrigins = [] }) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('HTTP token must contain 32 random bytes encoded as 64 lowercase hex characters.')
  const endpoint = urlToken ? `/mcp/${token}` : '/mcp'
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const requestPath = (req.url ?? '').split('?')[0]
    if (!same(requestPath, endpoint)) { res.writeHead(404).end(); return }
    if (!urlToken && !same(req.headers.authorization ?? '', `Bearer ${token}`)) { res.writeHead(401).end(); return }
    // Validate Host and Origin even behind a proxy; explicitly allow its public host.
    let hostname
    try { hostname = new URL(`http://${req.headers.host}`).hostname } catch { res.writeHead(400).end(); return }
    if (!allowedHosts.includes(hostname)) { res.writeHead(403).end(); return }
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405).end(); return }
    const server = createKnowledgeServer(store)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 })
    res.on('close', () => { server.close().catch(() => {}) })
    try { await server.connect(transport); await transport.handleRequest(req, res) } catch (error) {
      // No request paths, headers, tokens, or memory bodies in logs.
      console.error('HTTP MCP request failed:', error.code ?? error.name)
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
      await server.close().catch(() => {})
    }
  })
  http.requestTimeout = 30000
  http.headersTimeout = 10000
  return http
}
