# 文档格式 / Document format

一份记忆对应一份 Markdown，YAML frontmatter 保存元数据。URI 使用 ASCII 路径，例如 `memory://project/paper-plane` 对应 `project/paper-plane.md`；标题和正文可以使用任意语言。

One memory is one Markdown file with YAML frontmatter. URI paths use portable ASCII names. Titles and bodies can use any language.

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
```

所有文档需要 `name`；Project 还需要非空 `description`。读取手写文档时可以省略 type/uri/tags/links，type 和 URI 由文件路径补齐，数组默认 `[]`。显式提供的 type/uri 必须与路径一致。

All documents need a name; projects also need a description. Handwritten files may omit type, URI, tags, and links. Supplied type and URI must match the file path.

可选字段 / Optional fields:

- `archived: true`：退出普通查找和基础上下文，精确 read 仍可读取。Excluded from ordinary find/context, still addressable by URI.
- `ambient: false`：Context 不进入基础上下文。Context becomes explicit-only.
- `scope: laptop` 或 `scope: [laptop, workstation]`：与 `--scope` 匹配的 Context 可以加载。Global Context 按 URI 路径识别。Scopes select device-specific context; global context uses `context/global/`.
- `status: reference`：Project 不进入近期目录。Exclude a reference project from recent-project orientation.
- `links: [{kind: explains, to: memory://note/decision}]`：类型化关系；也接受旧式 URI 字符串，读取时解释为 related。Typed relations, returned separately from canonical body.

通过 MCP 创建会自动写入 type、uri、created、updated 和 version。更新可用 patch/append/replace；元数据修改放在 `frontmatter` 对象里，例如 `{"archived":true}`。type、uri、created 和 version 由存储层维护，不允许通过更新替换。

MCP creation sets timestamps and version. Updates use patch, append, or replace; put metadata changes inside `frontmatter`. Storage owns type, URI, creation time, and version.

etag 是当前文件原始内容的 SHA-256。直接编辑 Markdown 后 etag 会改变；Agent 必须重读再更新。CRLF 文件可读取。重复 YAML key、错误类型、URI 不一致等通过 status 报告。

An etag hashes the raw file. External edits change it. CRLF is accepted. Invalid YAML and metadata are reported rather than silently repaired.

## 实现边界 / Implementation boundaries

- `src/format.mjs`：唯一的格式验证、URI 和词法评分逻辑。The only format and scoring implementation.
- `src/store.mjs`：存储、初始化、容错扫描、上下文、关系和本机写入锁。Store and deterministic projections.
- `src/server.mjs`：六工具注册，stdio 与 HTTP 共用。Shared MCP factory.
- `src/http.mjs`：认证、Host/Origin 验证与 stateless Streamable HTTP。HTTP transport and authentication.
- `src/sync.mjs`：本机 Syncthing ignore 规则，不负责文件复制。Local sync preparation, not replication.
- `src/cli.mjs`：命令行入口。CLI entry.

本机锁位于系统临时目录，不进入同步语料。锁覆盖同一用户、同一物理 root 上的本机工具写入；其他用户、外部编辑器、远端设备和文件同步不参与。写入通过同目录临时文件加 rename 替换；这不是跨设备锁，也不保证突然断电时的持久性。外部修改在最终检查后发生，仍可能竞争，应依赖版本备份和冲突复查。

Local locks live outside the replicated corpus. They coordinate local tool writes for the same OS user and physical root. Atomic rename prevents partial tool updates; it is not a distributed transaction or a power-loss durability guarantee. External writers can still race after the final check.

内部 `.agent-knowledge.json` 只保存初始化标记，不保存记忆或凭证。第一次启动只为空库写入说明；显式 init 可补缺失说明。种子说明修改后，升级不会替换它。

The local initialization marker is not a memory. Startup seeds a fresh library; explicit init can add a missing guide without replacing edits.
