import { createHash } from 'node:crypto'

export const RANKING_DEFAULTS = Object.freeze({ k: 60, candidates: 40, k1: 1.2, b: 0.75 })
export const BM25_WEIGHTS = Object.freeze({ name: 3, path: 1, description: 2, tags: 1.5, headings: 2, body: 1, links: 0.5 })

const cache = new Map()
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const FUNCTION_WORDS = new Set(
  '的 了 是 我 你 我们 我的 一下 什么 怎么 如何 时候 的话 这个 那个 哪些 是否 需要 可以 以及 还有 和 与 或 把 被 为 对 给 要 想 找 说 请 帮 从 往 在 上 中 里'.split(' '),
)

export function extractHeadings(body = '') {
  const headings = []
  let fence = null
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = null
      continue
    }
    if (fence) continue
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) headings.push(match[1])
  }
  return headings
}

export function wordTokens(value) {
  const out = []
  const singles = []
  const flush = () => {
    if (singles.length > 1) {
      for (let i = 1; i < singles.length; i++) out.push(singles[i - 1] + singles[i])
    }
    out.push(...singles)
    singles.length = 0
  }
  for (const { segment, isWordLike } of segmenter.segment(String(value ?? '').normalize('NFKC').toLowerCase())) {
    if (!isWordLike || FUNCTION_WORDS.has(segment)) {
      flush()
      continue
    }
    if (/^\p{Script=Han}$/u.test(segment)) singles.push(segment)
    else {
      flush()
      out.push(...(segment.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? []))
    }
  }
  flush()
  return out
}

export function lexicalPassages(body = '', maxChars = 1000) {
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new RangeError('Invalid passage size')
  const spans = []
  let start = 0
  while (start < body.length) {
    let end = Math.min(body.length, start + maxChars)
    if (end < body.length) {
      const boundary = body.lastIndexOf('\n\n', end)
      if (boundary > start + maxChars / 3) end = boundary + 2
      else {
        const line = body.lastIndexOf('\n', end)
        if (line > start + maxChars / 3) end = line + 1
      }
      if (end < body.length && /[\uDC00-\uDFFF]/u.test(body[end])) end--
    }
    spans.push({ start, end, text: body.slice(start, end) })
    start = end
  }
  return spans.length ? spans : [{ start: 0, end: 0, text: '' }]
}

// Reproducible across hosts: Han bigrams plus separate Latin/number runs.
export function rankingTokens(value) {
  const out = []
  for (const run of String(value ?? '').normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      const chars = [...run]
      if (chars.length === 1) out.push(run)
      else for (let i = 1; i < chars.length; i++) out.push(chars[i - 1] + chars[i])
    } else {
      out.push(run)
    }
  }
  return out
}

export function rankingFields(doc) {
  let location = doc.path ?? doc.uri ?? ''
  try { location = decodeURIComponent(location) } catch { /* retain malformed percent escapes as literal text */ }
  const fm = doc.frontmatter ?? {}
  const name = doc.name ?? fm.name ?? ''
  const description = doc.description ?? fm.description ?? ''
  const tags = doc.tags ?? fm.tags ?? []
  const links = doc.links ?? fm.links ?? []
  const body = doc.body ?? ''
  const headings = doc.headings ?? extractHeadings(body)
  return {
    name,
    path: location,
    description,
    tags: tags.join(' '),
    headings: headings.map(h => typeof h === 'string' ? h : h.title).join(' '),
    body,
    links: links.map(l => typeof l === 'string' ? l : `${l.kind ?? ''} ${l.to ?? ''}`).join(' '),
  }
}

export class BM25Index {
  constructor(docs, { k1 = RANKING_DEFAULTS.k1, b = RANKING_DEFAULTS.b, weights = BM25_WEIGHTS, tokenizer = 'bigrams', local = false } = {}) {
    if (!Number.isFinite(k1) || k1 <= 0 || !Number.isFinite(b) || b < 0 || b > 1) throw new RangeError('Invalid BM25 parameters')
    if (Object.entries(weights).some(([field, weight]) => !(field in BM25_WEIGHTS) || !Number.isFinite(weight) || weight < 0)) throw new RangeError('Invalid BM25 field weights')
    if (!['bigrams', 'words'].includes(tokenizer)) throw new RangeError('Unknown tokenizer')
    this.k1 = k1
    this.b = b
    this.weights = weights
    this.count = docs.length
    this.tokenize = tokenizer === 'words' ? wordTokens : rankingTokens
    this.local = local
    this.documents = new Map()
    this.postings = new Map()
    this.averages = {}
    const totals = {}
    const counts = {}

    for (const doc of docs) {
      if (this.documents.has(doc.uri)) throw new Error(`Duplicate retrieval URI: ${doc.uri}`)
      const indexed = { lengths: {}, frequencies: {} }
      const unique = new Set()
      for (const [field, text] of Object.entries(rankingFields(doc))) {
        const tokens = this.tokenize(text)
        const frequency = new Map()
        for (const token of tokens) {
          frequency.set(token, (frequency.get(token) ?? 0) + 1)
          unique.add(token)
        }
        indexed.lengths[field] = tokens.length
        indexed.frequencies[field] = frequency
        if (tokens.length && !(local && field === 'body')) {
          totals[field] = (totals[field] ?? 0) + tokens.length
          counts[field] = (counts[field] ?? 0) + 1
        }
      }
      if (local) {
        indexed.passages = lexicalPassages(doc.body ?? '').map(span => {
          const tokens = this.tokenize(span.text)
          const frequency = new Map()
          for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
          if (tokens.length) {
            totals.body = (totals.body ?? 0) + tokens.length
            counts.body = (counts.body ?? 0) + 1
          }
          return { ...span, length: tokens.length, frequency }
        })
      }
      this.documents.set(doc.uri, indexed)
      for (const token of unique) {
        if (!this.postings.has(token)) this.postings.set(token, [])
        this.postings.get(token).push(doc.uri)
      }
    }
    for (const field of Object.keys(BM25_WEIGHTS)) {
      this.averages[field] = (totals[field] ?? 0) / (counts[field] || 1)
    }
  }

  search(query) {
    const scores = new Map()
    for (const token of new Set(this.tokenize(query))) {
      const posting = this.postings.get(token)
      if (!posting) continue
      const idf = Math.log(1 + (this.count - posting.length + 0.5) / (posting.length + 0.5))
      for (const uri of posting) {
        const doc = this.documents.get(uri)
        if (!scores.has(uri)) scores.set(uri, new Map())
        for (const [i, passage] of (doc.passages ?? [null]).entries()) {
          let tf = 0
          for (const [field, weight] of Object.entries(this.weights)) {
            const frequency = field === 'body' && passage ? (passage.frequency.get(token) ?? 0) : (doc.frequencies[field]?.get(token) ?? 0)
            const length = field === 'body' && passage ? passage.length : doc.lengths[field]
            if (frequency) tf += weight * frequency / (1 - this.b + this.b * length / (this.averages[field] || 1))
          }
          const score = idf * tf * (this.k1 + 1) / (tf + this.k1)
          if (score > 0) scores.get(uri).set(i, (scores.get(uri).get(i) ?? 0) + score)
        }
      }
    }
    return [...scores]
      .flatMap(([uri, passageScores]) => {
        const best = [...passageScores].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
        if (!best) return []
        const passage = this.documents.get(uri).passages?.[best[0]]
        return [{ uri, score: best[1], ...(passage ? { match: { start: passage.start, end: passage.end, excerpt: passage.text } } : {}) }]
      })
      .sort(order)
  }
}

export function bm25Rank(docs, query, options = {}) {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(options))
  for (const doc of docs) hash.update(JSON.stringify([doc.uri, rankingFields(doc)]))
  const key = hash.digest('hex')
  if (!cache.has(key)) {
    cache.set(key, new BM25Index(docs, options))
    if (cache.size > 3) cache.delete(cache.keys().next().value)
  }
  return cache.get(key).search(query)
}

export function rrfFuse(rankings, { k = RANKING_DEFAULTS.k, weights = rankings.map(() => 1), window = RANKING_DEFAULTS.candidates } = {}) {
  if (!Number.isFinite(k) || k < 0 || !Number.isInteger(window) || window < 1 || weights.length !== rankings.length || weights.some(w => !Number.isFinite(w) || w < 0)) {
    throw new RangeError('Invalid RRF parameters')
  }
  const fused = new Map()
  rankings.forEach((ranking, channel) => {
    const seen = new Set()
    for (const entry of ranking) {
      if (seen.has(entry.uri)) continue
      if (seen.size >= window) break
      seen.add(entry.uri)
      if (!weights[channel]) continue
      fused.set(entry.uri, (fused.get(entry.uri) ?? 0) + weights[channel] / (k + seen.size))
    }
  })
  return [...fused].map(([uri, score]) => ({ uri, score })).sort(order)
}

export function fuseEvidence(docs, query, dense = [], { limit = 12, lexicalOptions = { tokenizer: 'bigrams', local: false }, lexicalRanking } = {}) {
  const lexical = lexicalRanking ?? bm25Rank(docs, query, lexicalOptions)
  const byUri = new Map(docs.map(d => [d.uri, d]))
  const lex = new Map(lexical.map((entry, i) => [entry.uri, { ...entry, rank: i + 1 }]))
  const vec = new Map(dense.map((entry, i) => [entry.uri, { ...entry, rank: i + 1 }]))
  const ranking = dense.length ? rrfFuse([lexical, dense]) : lexical
  const hits = ranking.filter(h => byUri.has(h.uri)).slice(0, limit).map(entry => ({
    ...entry,
    lexicalMatch: lex.get(entry.uri)?.match ?? matchingPassage(byUri.get(entry.uri).body ?? '', query, lexicalOptions.tokenizer),
    vectorMatch: vec.get(entry.uri),
    signals: {
      ...(lex.has(entry.uri) ? { bm25: lex.get(entry.uri).score, lexicalRank: lex.get(entry.uri).rank } : {}),
      ...(vec.has(entry.uri) ? { dense: vec.get(entry.uri).score, vectorRank: vec.get(entry.uri).rank } : {}),
      ...(dense.length ? { rrf: entry.score } : {}),
    },
  }))
  return { hits, lexical, agree: !!lexical.length && lexical[0].uri === dense[0]?.uri }
}

export function matchingPassage(body = '', query, tokenizer = 'bigrams') {
  const tokenize = tokenizer === 'words' ? wordTokens : rankingTokens
  const terms = new Set(tokenize(query))
  const spans = lexicalPassages(body).map(span => ({
    ...span,
    matches: new Set(tokenize(span.text).filter(term => terms.has(term))).size,
  }))
  const best = spans.sort((a, b) => b.matches - a.matches || a.start - b.start)[0]
  return { start: best.start, end: best.end, excerpt: best.text }
}

export function modelEligible(doc) {
  const type = doc?.type ?? doc?.frontmatter?.type
  const archived = doc?.archived || doc?.frontmatter?.archived
  return Boolean(doc && !archived && (type === 'note' || type === 'project'))
}

export function rerankText(doc, hit) {
  const snippets = [hit.vectorMatch?.excerpt, hit.lexicalMatch?.excerpt].filter(Boolean)
  const unique = [...new Set(snippets)]
  const name = doc.name ?? doc.frontmatter?.name ?? ''
  const description = doc.description ?? doc.frontmatter?.description ?? ''
  return [name, doc.uri, description, ...unique.map(s => s.slice(0, 1200))].filter(Boolean).join('\n')
}

export function sanitizeModelText(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:ah-|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s`"']+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s<>`"')]+/g, value => {
      try { const u = new URL(value); return `${u.protocol}//${u.host}/[path omitted]` } catch { return '[URL omitted]' }
    })
    .replace(/\b[A-Za-z0-9_+/-]{32,}={0,2}\b/g, '[opaque value omitted]')
    .replace(/^.*(?:password|passwd|secret|api[_ -]?key|token|密钥|密码)\s*[=:：]\s*[`"']?[^\s`"']+.*$/gim, '[credential assignment omitted]')
}

export async function rerankEvidence(docs, query, fused, provider, { skipAgreement = true, sanitize = true } = {}) {
  const byUri = new Map(docs.map(d => [d.uri, d]))
  const pool = fused.hits.slice(0, 12).filter(h => modelEligible(byUri.get(h.uri)))
  if (!provider || pool.length < 2 || (skipAgreement && fused.agree)) return { hits: fused.hits, used: false }
  const clean = sanitize ? sanitizeModelText : value => value
  const result = await provider(clean(query), pool.map(h => clean(rerankText(byUri.get(h.uri), h))))
  if (!Array.isArray(result) || result.length !== pool.length || new Set(result.map(r => r.index)).size !== pool.length || result.some(r => !Number.isInteger(r.index) || r.index < 0 || r.index >= pool.length || !Number.isFinite(r.relevance_score))) {
    throw new Error('Invalid rerank response')
  }
  const sorted = [...result]
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .map(row => ({ ...pool[row.index], signals: { ...pool[row.index].signals, rerank: row.relevance_score } }))
  let next = 0
  const included = new Set(pool.map(h => h.uri))
  return { hits: fused.hits.map(h => included.has(h.uri) ? sorted[next++] : h), used: true }
}

function order(a, b) {
  return b.score - a.score || a.uri.localeCompare(b.uri)
}
