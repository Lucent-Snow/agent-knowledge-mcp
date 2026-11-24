# 文档格式 / Document format

一份记忆对应一份 Markdown，YAML frontmatter 保存元数据。URI 使用 ASCII 路径，例如 `memory://project/paper-plane` 对应 `project/paper-plane.md`，`memory://project/paper-plane/spec` 对应 `project/paper-plane/spec.md`，而 `memory://skill/release-check` 对应 `skill/release-check/SKILL.md`。标题和正文可以使用任意语言。

One memory is one Markdown document with YAML frontmatter. Skills live as bundles at `skill/<slug>/SKILL.md` alongside optional helper files such as `scripts/` or `docs/`. Titles and bodies can use any language.

```markdown
---
type: project
uri: memory://project/paper-plane
name: 纸飞机
description: 纸飞机项目的范围、状态和关键决定
tags: [paper-plane]
links: []
created: "2026-01-01T00:00:00.000Z"
updated: "2026-01-01T00:00:00.000Z"
version: 1
---
# 纸飞机

第一版先支持本地使用。理由：先验证记忆的完整读写流程。

<!-- knowledge:history -->
## 历史讨论
早期备选与已被取代的思路。
<!-- /knowledge:history -->
```

所有文档需要 `name`；`project` 与 `skill` 还需要非空 `description`。手写文档可省略 `type`/`uri`/`tags`/`links`，由文件路径自动推导；显式填写时必须与路径一致。

All documents require `name`; `project` and `skill` require a non-empty `description`. Paired `<!-- knowledge:history -->` / `<!-- /knowledge:history -->` lines must be balanced and non-nested outside code fences.

## 可选字段与目录约定 / Optional fields and layout

- **归档位置（`archive/<type>/...`）**：通过 `knowledge_maintain(action: "archive")` 将文档（或整个 `skill/` 目录）迁入 `archive/`。URI 不变，工具结果返回推导字段 `archived: true`，新写入的 YAML 不再保留冗余归档标记；手动添加的旧版 `archived: true` 仍兼容读取，并在更新时迁移为目录归档。
- **72 小时回收站（`.trash/<uuid>.json`）**：`knowledge_delete` 先写入恢复记录再移除源文件（`skill` 连同目录移至 `.trash/<uuid>-bundle`），过期前可通过 `knowledge_maintain(action: "restore")` 恢复，不覆盖同名新建文档。
- **`ambient: false` / `pinned: true`**：控制 `context` 是否自动注入基础上下文，以及 `skill` 是否置顶于 `/skills/recent`。
- **`scope: laptop` 或 `scope: [laptop, workstation]`**：与 `--scope` 匹配的 Context 可以加载；全局 Context 位于 `context/global/`。
- **`status: reference`**：Project 不进入近期项目目录（`/projects/recent`）。
- **`updatedBy`**：当配置 `--actor` / `AGENT_KNOWLEDGE_ACTOR` 时自动记录最近修改者标识。
- **`links: [{kind: explains, to: memory://note/decision}]`**：类型化关系；也接受旧式 URI 字符串（解析为 `related`）。读取顶层项目时还会独立返回活跃子笔记摘要 `children`。

## 实现边界 / Implementation boundaries

- `src/sections.mjs`：显式 `<!-- knowledge:history -->` 区段解析与偏移保持投影。
- `src/format.mjs`：URI 验证、路径映射（含 `skill` 与 `archive/`）、项目子笔记作用域与 frontmatter 校验。
- `src/ranking.mjs` / `src/lexical-index.mjs`：可丢弃的 `node:sqlite` 双字/词单元 BM25F 索引与纯内存降级实现；缓存默认位于 `~/.cache/agent-knowledge-mcp/`（可通过 `--cache-dir` 或 `--no-index` 控制）。
- `src/access-stats.mjs`：Skill 本机 LRU 访问统计（`node:sqlite`），只读访问不污染 Markdown。
- `src/providers.mjs` / `src/vectors.mjs`：可选 OpenAI 兼容 `/v1/embeddings` 与 `/v1/rerank` 客户端及增量 SQLite 向量缓存；未配置环境变量时不发起任何网络请求，异常自动熔断并降级。
- `src/maintenance.mjs`：变化列表（`changes`）与位于语料之外的本地检查点（`<root>-maintenance` 或 `--maintenance-root`）。
- `src/store.mjs`：跨进程文件锁、乐观并发控制、归档迁移、72 小时回收站、检索与上下文投影。
- `src/server.mjs`：七工具注册，stdio 与 HTTP 共用。
- `src/http.mjs`：认证、Host/Origin 验证与 stateless Streamable HTTP。
- `src/sync.mjs`：本机 Syncthing ignore 规则。
- `src/cli.mjs`：命令行入口。
