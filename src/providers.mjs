// Optional OpenAI-compatible embedding and rerank provider clients.
// Zero network calls occur when endpoints are unconfigured. All calls fail soft
// via a one-shot per-process circuit breaker so a dead upstream never stalls
// subsequent deterministic searches.

function endpointUrl(base, suffix) {
  const trimmed = String(base).trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`
}

async function post(url, key, body, timeoutMs = 30000, fetchImpl = fetch) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    const error = new Error(`Provider HTTP ${res.status}`)
    error.status = res.status
    error.responseBody = text.slice(0, 2000)
    throw error
  }
  return JSON.parse(text)
}

function circuit(label, fn) {
  let dead = null
  return async (...args) => {
    if (dead) throw dead
    try {
      return await fn(...args)
    } catch (error) {
      dead = new Error(`${label} unavailable: ${error.message}`)
      throw dead
    }
  }
}

export function createProviders(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch

  const embedBase = (options.embedBase ?? env.AGENT_KNOWLEDGE_EMBED_BASE ?? '').trim()
  const embedKey = (options.embedKey ?? env.AGENT_KNOWLEDGE_EMBED_KEY ?? '').trim()
  const embedModel = (options.embedModel ?? env.AGENT_KNOWLEDGE_EMBED_MODEL ?? 'text-embedding-3-small').trim()
  const batchSize = Math.max(1, Number(options.embedBatchSize ?? env.AGENT_KNOWLEDGE_EMBED_BATCH_SIZE ?? 16))
  const embedTimeout = Math.max(1000, Number(options.embedTimeoutMs ?? env.AGENT_KNOWLEDGE_EMBED_TIMEOUT_MS ?? 30000))

  const rerankBase = (options.rerankBase ?? env.AGENT_KNOWLEDGE_RERANK_BASE ?? '').trim()
  const rerankKey = (options.rerankKey ?? env.AGENT_KNOWLEDGE_RERANK_KEY ?? '').trim()
  const rerankModel = (options.rerankModel ?? env.AGENT_KNOWLEDGE_RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3').trim()
  const rerankTimeout = Math.max(1000, Number(options.rerankTimeoutMs ?? env.AGENT_KNOWLEDGE_RERANK_TIMEOUT_MS ?? 15000))

  const embed = options.embed ?? (embedBase
    ? circuit('embedding', async (texts) => {
        const out = []
        const url = endpointUrl(embedBase, '/embeddings')
        for (let i = 0; i < texts.length; i += batchSize) {
          const slice = texts.slice(i, i + batchSize)
          const res = await post(url, embedKey, { model: embedModel, input: slice }, embedTimeout, fetchImpl)
          if (!Array.isArray(res.data) || res.data.length !== slice.length) {
            throw new Error('Embedding response count mismatch')
          }
          const ordered = [...res.data].sort((a, b) => a.index - b.index)
          if (ordered.some((row, index) => row.index !== index)) {
            throw new Error('Embedding response indices mismatch')
          }
          out.push(...ordered.map(row => row.embedding))
        }
        return out
      })
    : null)

  const rerank = options.rerank ?? (rerankBase
    ? circuit('rerank', async (query, documents) => {
        const url = endpointUrl(rerankBase, '/rerank')
        const res = await post(url, rerankKey, {
          model: rerankModel,
          query,
          documents,
          top_n: documents.length,
        }, rerankTimeout, fetchImpl)
        return res.results ?? res.data ?? null
      })
    : null)

  return { embedModel, rerankModel, embed, rerank }
}
