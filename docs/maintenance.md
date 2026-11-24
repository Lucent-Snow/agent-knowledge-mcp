# 增量检查、回收站与维护操作 / Maintenance, changes & recycle bin

`knowledge_status` 与 `knowledge_maintain` 将**只读诊断/变化拉取**和**状态变更/进度提交**严格拆开，使定时批处理与多端协作可审计、可重试、可恢复。

## 1. 只读诊断与增量视图（`knowledge_status`）

- **`view: "health"`**（默认）：扫描活跃区、归档区与 `.trash/`，报告坏文档、Syncthing `.sync-conflict-*` 副本以及活跃区/归档区同名并存的 `LOCATION_CONFLICT`。
- **`view: "changes"`**：按 `[since, until)` 窗口返回新建、更新和未永久清除的删除摘要：
  ```json
  { "view": "changes", "checkpoint": "nightly", "limit": 100 }
  ```
  - 也可传入 `day: "today"` / `"YYYY-MM-DD"` + 可选 `timeZone`（默认宿主本地时区），或直接传 `since`/`until`（带时区的 ISO 时间戳）。
  - 返回 `window.until`、`checkpoint.etag`、`changes`、`undated`、`warnings` 和分页 `nextCursor`。
  - 使用同一 `checkpoint` 和 `cursor` 翻完所有页；注意读操作本身**绝不**推进 checkpoint。
- **`view: "checkpoint"`**：查看指定命名任务当前的水位位置。
- **`view: "trash"`**：列出 72 小时保留期内的可恢复删除记录。
- **`view: "vectors"`**：查看可选向量索引的模型、维度与缓存覆盖率（不触发任何 embedding 生成）。

## 2. 显式维护变更（`knowledge_maintain`）

所有变更均受显式参数和乐观并发保护：

- **`action: "archive"` / `"unarchive"`**：使用最新 `etag` 将文档或完整 `skill/` 目录迁入或迁出 `archive/<type>/...`。URI 保持不变，不向 Markdown 注入归档标记。
- **`action: "restore"`**：在 72 小时保留期内按 `trash://<uuid>` 与回收条目 `etag` 还原文档或 Skill 束（含原有归档位置）；若同一 URI 已新建其他文档，会拒绝覆盖（`ALREADY_EXISTS`）。
- **`action: "purge_expired"`**：显式物理清理已超过 72 小时的有效回收记录；损坏记录或冲突副本会被保留并报告警告，避免误删。
- **`action: "checkpoint"`**：当批处理翻页与所有修改确认无误后，用 `through: window.until` 与 `expectedEtag: checkpoint.etag` 提交本地水位：
  ```json
  {
    "action": "checkpoint",
    "checkpoint": "nightly",
    "through": "2026-11-13T10:00:00.000Z",
    "expectedEtag": "missing"
  }
  ```

## 本地状态目录与多端边界 / Local checkpoints vs sync

Checkpoint 是**每台主机上的本地作业进度**，默认存储在语料目录旁的 `<dirname(root)>/<basename(root)>-maintenance/checkpoints/<name>.json`（可通过 `--maintenance-root` 或 `AGENT_KNOWLEDGE_MAINTENANCE_ROOT` 覆盖），绝不放入 Syncthing 同步目录，因此不会在多设备间产生冲突。`.trash/` 与 `archive/` 则随语料一同同步。
