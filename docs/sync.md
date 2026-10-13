# 多端同步 / Device sync

每台电脑保存自己的 Markdown 副本，并运行本地 MCP。Syncthing 负责文件复制；本包负责格式、读写和冲突诊断。无需 VPS 才能用两台设备；常在线节点可以帮助不同时在线的设备汇聚。

Each device keeps a local Markdown copy and MCP process. Syncthing replicates files; this package owns memory semantics. An always-on peer is optional.

自己的 Linux VPS 从安装到配对见 [vps.md](vps.md)；具体故障见 [troubleshooting.md](troubleshooting.md)。只希望客户端共享服务器的一份库，可以使用 [远程 MCP](remote.md)；需要离线副本时再配置本篇的同步。

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

<a id="roundtrip"></a>
## 如何确认真的同步成功

先确认双方 Syncthing 显示 Connected，并且共享文件夹完成扫描、Up to Date。然后使用双方实际 MCP 客户端验收：

1. A 创建一条唯一的临时 Note，例如 `memory://note/setup-check-unique-id`，写入可辨认的测试内容。先确认该 URI 不存在，避免操作真实记忆。
2. 等待传播后，B 精确 read 同一 URI，检查正文和 etag。也查看两端实际 Markdown 和各自 Syncthing 状态，排除连接错 root。
3. B 使用其刚读取的 etag 更新正文。等待 A 读取到新正文和新 etag。
4. A 重读后，以最新 etag 删除临时记忆。等待 B 精确 read 返回 NOT_FOUND。
5. 双方 status 检查是否存在坏文档或冲突副本，再确认 Syncthing 没有待传内容。

等待超过预期时先查同步状态，不用盲目创建第二份记忆。A 的更新返回成功只表示 A 的本地写入成功；B 曾读到旧版本不证明此次更新已传播。记录观察到的结果，不把“已配置”当作“已同步”。

## 日常边界

- 休眠或离线设备不能接收新内容；重新联网后等待同步，再对共享主题进行修改。
- 初次接收时，先获取已有语料再启动 MCP，避免重复初始化说明；全新库只由选定的源端先初始化。
- 相同 Folder ID 才表示同一个共享目录，Label 和绝对路径可以不同。已有两套独立记忆不能靠同名文件夹安全合并，需先备份并显式整理。
- Send Only / Receive Only 与本文的双向编辑流程不同；如果刻意选择这些模式，按其语义使用，不随意点击 Override/Revert。
- Syncthing 版本保留不是本机每次写入的日志，主要作用于收到的远端替换/删除；另外保存独立备份。[官方版本保留说明](https://docs.syncthing.net/users/versioning.html)
- 移除设备前解除共享；仍在共享时删除文件，会向其他设备传播。停止 HTTP MCP 不会停止文件同步。

`sync-prepare` 只准备规则；`knowledge_status` 只检查当前语料。它们都不会安装 Syncthing、配对设备或读取其网络连接状态。
