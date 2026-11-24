# 记忆质量与定期整理 / Memory curation & batch review

长期记忆的价值不在于“什么都存”，而在于未来任意 Agent 都能找得到、读得懂、敢信任，并且在事态变化时更新同一份主题文档。

Effective long-term memory depends on active curation—updating existing topics, separating historical noise, retiring stale entries, and preventing duplicate summaries.

## 写入与整理标准 / Curation standards

1. **先定位主题**：先查再写；同一项目或同一结论保持一个主入口，不要用“某年某月会话总结”新建碎片文件。项目细节可作为子笔记放在 `memory://project/<id>/<sub-note>` 下，保持主入口紧凑清晰。
2. **元数据面向真实问题**：`name` 点明对象；`description` 说明“遇到什么问题时应当读这篇”；`tags` 覆盖核心实体与常见别名。
3. **整合现状而不是追加 V2/V3**：新决定直接更新现状并写明依据，被取代的旧做法从现行表述撤下。
4. **区分现行与历史（`<!-- knowledge:history -->`）**：当演变过程有追溯价值时，用独占一行的成对标记隔离旧讨论与试错过程：

```markdown
# 某项目决策

## 现行方案
当前采用架构 B，原因：维护成本与多端一致性更优。

<!-- knowledge:history -->
## 早期方案记录
曾评估架构 A，因并发锁语义冲突于上一版放弃。
<!-- /knowledge:history -->
```

- 默认检索（BM25F）、基础 `knowledge_context` 与可选向量检索都会屏蔽 `history` 区段；
- `knowledge_find(includeHistory: true)` 做全文词法检索并返回命中所在的 `contentRole`（`current` / `history` / `mixed`）；
- `knowledge_read` 始终返回完整正文，并附带 `contentSections`。

5. **退场分流**：还有历史查证价值但不常用 -> `knowledge_maintain(action: "archive")` 迁入 `archive/`；无保留价值或纯重复草稿 -> `knowledge_delete` 进入 72 小时 `.trash/` 回收站。

## 定期跑批整理提示词模板 / Scheduled batch curation prompt

你可以配合自己的定时任务（如系统 cron、`agent-knowledge-mcp status`、外部 Agent 调度器）定期执行一次“增量变化批处理”。下面提供一段可直接复用的通用整理 Prompt：

```text
请作为长期记忆维护助手，对知识库执行一次增量整理批处理：

1. 首先检查健康状态与增量窗口：
   - 调用 knowledge_status(view: "health")，若存在 conflicts 或 invalidDocuments，优先列出并明确报告，不要静默覆盖冲突文件。
   - 调用 knowledge_status(view: "changes", checkpoint: "nightly", limit: 100)。
   - 记录本次返回的 window.until 与 checkpoint.etag；若存在 nextCursor，使用相同 checkpoint 和 limit 持续翻页读完所有变化。

2. 逐条审阅变化列表（created / updated / deleted）：
   - 对每条候选先用 knowledge_read 读取完整正文、relations 与 etag（注意：读取本身不会推进 checkpoint）。
   - 检查是否与已有主题重复：若属于同一主题，将新信息合并入主文档并调整 links，重复空壳通过 knowledge_delete 移入回收站。
   - 检查时效与结构：已被推翻的旧决策是否仍混在现行段落中？如有追溯价值，移入 <!-- knowledge:history --> ... <!-- /knowledge:history -->；不再需要日常检索但有档案价值的项目/笔记，调用 knowledge_maintain(action: "archive") 归档；明显失效的工作进度或误记，用 knowledge_delete(uri, expectedEtag, reason) 移入 72 小时回收站。
   - 检查项目层次：过大的 project 正文是否适合拆出 memory://project/<id>/<sub-note> 子笔记？
   - 检查元数据：description 与 tags 是否能覆盖真实问法。

3. 整理完成后验证：
   - 用自然语言问题调用 knowledge_find 验证关键修改能否命中正确文档，确认历史段落未污染默认检索。
   - 确认本轮所有页面和整理动作都已完成后，调用：
     knowledge_maintain(action: "checkpoint", checkpoint: "nightly", through: "<第一步记录的 window.until>", expectedEtag: "<第一步记录的 checkpoint.etag>")
   - 若需要清理过期回收记录，显式调用 knowledge_maintain(action: "purge_expired")。

4. 最后输出简洁报告：列出审查窗口、处理条目及动作、合并/归档/删除清单（含恢复用 trash:// URI）、遗留冲突以及 checkpoint 是否成功提交。
```

> [!NOTE]
> `knowledge_status(view: "changes")` 是纯粹的只读检查，永远不会自动推进 `checkpoint`。如果整理中途出错或中断，下一次任务仍会从上一次已提交的水位重新拉取，避免遗漏未处理的变更。
