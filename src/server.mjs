import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { KnowledgeError, KnowledgeStore } from './store.mjs'
import { TRASH_RETENTION_MS } from './format.mjs'

const types = z.enum(['context', 'project', 'note', 'identity', 'skill'])
const link = z.union([z.string(), z.object({ kind: z.string(), to: z.string(), added: z.string().optional() })])
const readOnlyTools = new Set(['knowledge_find', 'knowledge_read', 'knowledge_context', 'knowledge_status'])

const respond = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })

export function createKnowledgeServer(store = new KnowledgeStore()) {
  const server = new McpServer({ name: 'agent-knowledge-mcp', version: '0.2.0' }, {
    instructions: 'Use knowledge_context for baseline background, knowledge_find to discover a URI, and knowledge_read before updates. Current user instructions override stored memories.',
  })

  function register(name, description, inputSchema, operation) {
    const readOnly = readOnlyTools.has(name)
    const annotations = {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: false,
    }
    server.registerTool(name, { description, inputSchema, annotations }, async args => {
      try {
        return respond(await operation(args))
      } catch (error) {
        if (error instanceof KnowledgeError) return { ...respond({ error: error.toJSON() }), isError: true }
        console.error(`agent-knowledge-mcp ${name}:`, error.code ?? error.name)
        return { ...respond({ error: { code: 'INTERNAL', message: 'Knowledge operation failed.' } }), isError: true }
      }
    })
  }

  register(
    'knowledge_find',
    'Browse or search Markdown memories. Uses incremental bigram BM25F over current sections by default, optionally fused (RRF k=60) with configured OpenAI-compatible embeddings and reranker (reranking applies by default to hybrid queries when configured; pass rerank: false or retrieval: "lexical" to skip). Project sub-notes (memory://project/<id>/<sub-note>) are excluded from global search/browsing by default; pass project to scope to one project and its sub-notes, or includeSubnotes true to include all sub-notes globally. Explicit <!-- knowledge:history --> sections are excluded by default; set includeHistory true to search full bodies lexically. Read full canonical files via knowledge_read before acting.',
    {
      query: z.string().optional(),
      type: types.optional(),
      tags: z.array(z.string()).optional(),
      status: z.string().optional(),
      project: z.string().optional(),
      includeSubnotes: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
      includeHistory: z.boolean().optional(),
      retrieval: z.enum(['hybrid', 'lexical', 'vector']).optional(),
      rerank: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    args => store.find(args),
  )

  register(
    'knowledge_read',
    'Read one exact memory://<type>/<path> document (with YAML metadata, current/history section spans, etag, outgoing/incoming relations, and child sub-note summaries on top-level projects) or a recoverable trash://<uuid> entry. For memory://skill/<name>, pass file to inspect a bundle subfile.',
    {
      uri: z.string(),
      relations: z.enum(['none', 'summary']).optional(),
      file: z.string().optional(),
    },
    ({ uri, relations, file }) => uri.startsWith('trash:')
      ? store.loadTrash(uri)
      : store.read(uri, { relations, file }),
  )

  register(
    'knowledge_context',
    'Return bounded baseline context (/ by default). Excludes Identity, Note, archived items, project sub-notes, and <!-- knowledge:history --> sections unless explicitly requested. Includes /skills and /skills/recent ordered by ambient flag and recent local access.',
    {
      path: z.enum(['/', '/system', '/context', '/projects/recent', '/identity', '/skills', '/skills/recent']).optional(),
    },
    ({ path }) => store.context(path),
  )

  register(
    'knowledge_write',
    'Create a new memory or update an existing one with optimistic concurrency (expectedEtag from knowledge_read). Optional full-line paired <!-- knowledge:history --> / <!-- /knowledge:history --> markers exclude historical logs from default retrieval and context while keeping knowledge_read complete. For memory://skill/<name>, pass files on create or file on update to manage bundle subfiles.',
    {
      mode: z.enum(['create', 'update']),
      uri: z.string(),
      expectedEtag: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      links: z.array(link).optional(),
      file: z.string().optional(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
      frontmatter: z.record(z.string(), z.unknown()).optional(),
      op: z.enum(['patch', 'append', 'replace']).optional(),
      oldString: z.string().optional(),
      newString: z.string().optional(),
      replaceAll: z.boolean().optional(),
      append: z.string().optional(),
    },
    args => {
      if (args.mode === 'create') {
        if (!args.name?.trim()) throw new KnowledgeError('INVALID_INPUT', 'create requires name.')
        return store.create(args)
      }
      if (!args.op && !args.file) throw new KnowledgeError('INVALID_INPUT', 'update requires op.')
      if (args.file && !args.op) args = { ...args, op: 'replace' }
      return store.edit(args)
    },
  )

  register(
    'knowledge_delete',
    'Move a memory or skill bundle to the 72-hour .trash recycle bin (requiring expectedEtag from knowledge_read). Returns a trash:// reference for inspection or restore. For ordinary retirement, prefer knowledge_maintain with action archive.',
    {
      uri: z.string(),
      expectedEtag: z.string(),
      reason: z.string().optional(),
    },
    ({ uri, expectedEtag, reason }) => store.delete(uri, expectedEtag, reason),
  )

  register(
    'knowledge_status',
    'Read-only maintenance and diagnostics views. Default health checks invalid documents and sync/location conflicts; changes lists created/updated memories and retained deletions in [since, until) using optional local checkpoint + cursor pagination (never auto-advancing); trash lists recoverable deletions; checkpoint reads local job state; vectors reports optional embedding index coverage.',
    {
      view: z.enum(['health', 'changes', 'trash', 'checkpoint', 'vectors']).optional(),
      since: z.string().datetime({ offset: true }).optional(),
      until: z.string().datetime({ offset: true }).optional(),
      day: z.string().optional(),
      timeZone: z.string().optional(),
      checkpoint: z.string().optional(),
      cursor: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    args => store.status(args),
  )

  register(
    'knowledge_maintain',
    `Explicit maintenance mutations separate from read-only status. checkpoint advances a local curation watermark after changes pagination completes; restore recovers a trash:// entry within ${TRASH_RETENTION_MS / 3600000} hours without overwriting recreated URIs; archive/unarchive moves a memory into or out of archive/ keeping its URI intact; purge_expired removes expired recycle entries.`,
    {
      action: z.enum(['checkpoint', 'restore', 'purge_expired', 'archive', 'unarchive']),
      checkpoint: z.string().optional(),
      through: z.string().datetime({ offset: true }).optional(),
      uri: z.string().optional(),
      expectedEtag: z.string().optional(),
    },
    async args => {
      if (args.action === 'checkpoint') {
        if (!args.through) throw new KnowledgeError('INVALID_INPUT', 'checkpoint action requires through timestamp.')
        if (!args.expectedEtag) throw new KnowledgeError('INVALID_INPUT', 'checkpoint action requires expectedEtag.')
        return store.maintenance.commit({ checkpoint: args.checkpoint ?? 'default', through: args.through, expectedEtag: args.expectedEtag })
      }
      if (args.action === 'restore') {
        if (!args.uri) throw new KnowledgeError('INVALID_INPUT', 'restore action requires a trash:// uri.')
        return store.restore(args.uri, args.expectedEtag)
      }
      if (args.action === 'archive' || args.action === 'unarchive') {
        if (!args.uri) throw new KnowledgeError('INVALID_INPUT', `${args.action} requires a memory:// uri.`)
        return store.setArchived(args.uri, args.expectedEtag, args.action === 'archive')
      }
      return store.purgeExpiredTrash()
    },
  )

  return server
}
