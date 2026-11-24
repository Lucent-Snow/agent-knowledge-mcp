# 检索架构与可选扩展 / Retrieval architecture & optional AI extensions

`agent-knowledge-mcp` 坚持**零配置、纯本地即用**：不配置任何外部模型与 API key 即可获得完整、稳定的多字段中文检索。需要跨语言语义召回或大模型重排时，也可以通过标准环境变量按需开启可选通道。

## 1. 默认词法引擎：增量 SQLite BM25F

- **分词策略**：对中文使用连续双字（Han bigrams）+ 单字回退，对英文和数字保留词元，NFKC 归一化后不依赖外部原生分词库，在 Linux/macOS/Windows 上行为完全一致。
- **多字段权重（BM25F）**：`name (3.0)` > `description (2.0)` = `headings (2.0)` > `tags (1.5)` > `path (1.0)` = `body (1.0)` > `links (0.5)`，`k1=1.2, b=0.75`。
- **可重建增量缓存**：利用 Node 内置 `node:sqlite` 将词项倒排表缓存至语料外目录（默认 `~/.cache/agent-knowledge-mcp/<hash>/lexical.sqlite`，可用 `--cache-dir` 指定或 `--no-index` 关闭并切换至完全一致的纯内存 BM25F）。
- **区段隔离**：默认倒排表只索引 `current` 区段（忽略 `<!-- knowledge:history -->`）；传入 `includeHistory: true` 时回退到包含历史区段的全文词法计算，并在每条命中上标注 `contentRole`。

## 2. 项目层次作用域隔离（Project scoping）

大型项目常衍生出多篇子笔记（`memory://project/<id>/<sub-note>`）。为了防止子笔记淹没全局搜索与基础上下文：

- 默认 `knowledge_find` 与 `knowledge_context(/projects/recent)` **自动过滤子笔记**，只暴露顶层 `memory://project/<id>`。
- 传入 `project: "<id>"`（或 `"memory://project/<id>"`）时，`knowledge_find` 会将检索或浏览范围锁定在该项目及其全部子笔记内。
- 传入 `includeSubnotes: true` 时可全局放开子笔记检索。
- 用 `knowledge_read` 读取顶层 `project` 时，会自动附带活跃子笔记清单 `children`。

## 3. 可选向量检索与重排（零耦合标准协议）

只有在显式配置 OpenAI 兼容环境变量时才会启用，**未配置时零网络请求**：

```sh
# 可选：启用 OpenAI 兼容 Embedding（RRF k=60 融合召回）
export AGENT_KNOWLEDGE_EMBED_BASE="https://api.openai.com/v1" # 或本地 Ollama/vLLM http://127.0.0.1:11434/v1
export AGENT_KNOWLEDGE_EMBED_KEY="..."                       # 本地免鉴权服务可留空
export AGENT_KNOWLEDGE_EMBED_MODEL="text-embedding-3-small"

# 可选：启用标准 /v1/rerank 重排（仅对前 12 个活跃 note/project 候选生效，且自动脱敏）
export AGENT_KNOWLEDGE_RERANK_BASE="https://api.example.com/v1"
export AGENT_KNOWLEDGE_RERANK_KEY="..."
export AGENT_KNOWLEDGE_RERANK_MODEL="BAAI/bge-reranker-v2-m3"
```

安全与优雅降级策略：
- **默认触发条件**：配置 `AGENT_KNOWLEDGE_RERANK_BASE` 后，默认的 `hybrid` 检索会自动启用重排；如需单次跳过，可传入 `rerank: false` 或 `retrieval: "lexical"`。
- **最小发送原则**：`context`、`identity`、`skill` 以及已归档文档**绝不**发送给向量或重排模型；`note`/`project` 中的 `<!-- knowledge:history -->` 区段也不切片入库，发送重排文本前还会自动对密钥、Token 与含路径 URL 做正则脱敏。
- **失败熔断**：上游超时或返回错误时，按单进程熔断并附带 `EMBEDDING_UNAVAILABLE` / `RERANK_UNAVAILABLE` 警告，立刻降级返回确切可用的 BM25F 排序。
- **实时校准**：向量缓存命中的文档会与磁盘最新 `etag` 及内容区段角色比对，避免返回过期或已被移入历史区段的内容。
