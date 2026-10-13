# 多端同步 / Device sync

每台电脑保存自己的 Markdown 副本，并运行本地 MCP。Syncthing 负责文件复制；本包负责格式、读写和冲突诊断。无需 VPS 才能用两台设备；常在线节点可以帮助不同时在线的设备汇聚。

Each device keeps a local Markdown copy and MCP process. Syncthing replicates files; this package owns memory semantics. An always-on peer is optional.

## 首台设备 / First device

1. 初始化：`agent-knowledge-mcp init --root /absolute/path/to/memory`。
2. 安装并启动 [Syncthing](https://syncthing.net/downloads/)。
3. 运行 `agent-knowledge-mcp sync-prepare --root /absolute/path/to/memory`，生成 `.stignore`。
4. 在 Syncthing 添加此目录，类型选择 **Send & Receive**，启用文件版本保留。分享给经确认的设备。

Initialize the library, install Syncthing, prepare ignores, then share the root as a Send & Receive folder with versioning.

## 新设备 / New device

1. 安装 Node、此包和 Syncthing。
2. 为准备接收的目录运行 `sync-prepare`。这个命令只准备目录和忽略规则，不创建默认说明。
3. 在 Syncthing 配对设备，接受已有文件夹，指向该目录。
4. 等初次同步完成，再启动 `serve --root /absolute/path/to/memory`。从源设备同步来的说明会被直接使用。
5. 让两个客户端分别读取同一条记忆；再做一条临时记忆的创建 → 传播 → 更新 → 传播 → 删除往返。

Prepare an empty receiving root before starting MCP, pair devices, accept the existing folder, and wait for the initial sync. Reuse the replicated guide instead of creating a second seed concurrently.

`.stignore` **不会自动同步**，每台设备都需要运行 sync-prepare。既有自定义规则保留在最前面；Syncthing 的第一条匹配规则优先。如果你已经用 `*` 忽略全部内容，需要自行检查规则是否允许四类记忆。

The local `.stignore` is not replicated. Run preparation on every device. Existing rules remain first and can override the generated include rules. See [official ignore semantics](https://docs.syncthing.net/users/ignoring.html).

生成规则只共享 context/project/note/identity，排除初始化标记、临时写入文件和其他根目录内容。同步冲突副本保留并传播，不能把它们忽略掉。锁和 HTTP 凭证不在语料里。

Generated rules include the four memory trees and retain conflict copies. Local initialization state and write temporary files are excluded. Locks live in the OS temporary directory; credentials belong outside the root.

## 冲突和备份 / Conflicts and backup

同一文件在两端离线修改后可能生成 `.sync-conflict-*.md`。普通查找和 context 不读取这些副本；`knowledge_status` 报告文件路径。

Concurrent device edits can create conflict copies. They are excluded from normal retrieval and reported by status.

处理时先读两个版本，确认要保留的事实和决定，用最新 etag 更新规范记忆；确认备份及传播后再清理冲突文件。系统不自动语义合并，也不提供跨设备事务。设备同时编辑的顺序不能由本机锁保证。

Resolve intentionally: inspect both versions, update the canonical memory, verify replication, then remove the conflict copy. Local locking does not coordinate devices or external editors.

同步会传播误删，文件版本保留也不等于独立备份。请另外备份语料；本包不安装后台备份或同步服务。

Deletion replicates too. Keep an independent backup; this package does not install daemons or backup jobs.

可以在常在线节点同时启动 HTTP MCP，远程客户端访问该节点，本地设备继续使用离线副本。远程修改到其他设备的传播仍是最终一致。

An always-on replica can also expose HTTP MCP. Remote writes remain subject to eventual replication to other devices.
