# 排查与边角情况 / Troubleshooting

先定位失败在哪一层：客户端启动 → MCP → 本地语料；或客户端 → HTTPS/代理 → HTTP MCP → VPS 语料；同步另查 Syncthing。提交问题时提供版本、系统、错误码和已脱敏的配置；凭证、秘密网址和个人记忆不放到日志或 Issue。

Troubleshoot one layer at a time. Use this guide with [VPS setup](vps.md), [remote access](remote.md), and [sync](sync.md). Redact credentials and personal memories when reporting an issue.

## 本地启动与记忆

| 现象 | 检查与处理 |
|---|---|
| Node 太旧、模块或语法错误 | 查看客户端实际调用的 Node，而不仅是交互式终端；本包需要 Node >=22。 |
| 找不到 npx/命令，终端能用但客户端不能 | 客户端可能不继承 shell 的 PATH；填写可执行文件绝对路径。Windows 客户端可能要求 npx.cmd。根据客户端格式配置，不盲目复制其他客户端的文件结构。 |
| 启动后一直没有普通文本输出 | stdio serve 正在等 MCP 客户端，stdout 是协议；这是预期。HTTP serve 也会持续运行，启动信息写 stderr。 |
| “什么都没记住”，只看到默认说明 | 检查实际 root、运行用户、env 和 CLI 参数。电脑、VPS、sudo 用户、Docker 容器可以各有独立 HOME；空库健康并不等于连接到目标库。 |
| 有文件但查不到 | 必须在四类目录内、使用合法 ASCII URI 路径、带有效 frontmatter。status 查看坏文档；archived 默认退出 find，ambient:false 只影响基础上下文，Identity 仍可显式 find/read。 |
| Context 没出现 | 查看 global 路径、ambient、scope 匹配、归档状态和截断提示；必要时精确 read。新 scope 不会自动移动记忆。 |
| 更新 ETAG_MISMATCH | 重读最新正文与 etag，判断旧修改是否仍适用，再提交更新；不要仅替换 etag 后盲写旧正文。 |
| LOCK_UNAVAILABLE / LOCK_LOST | 检查是否有其他本机写入、目录/临时目录权限、异常进程；等操作结束再重读重试。正常终止和陈旧锁会由锁机制处理，不要在活动写入期间手动删锁。 |
| 手写 YAML 报错 | name 必须是文本，Project 需要 description；注意重复 key、URI/type 不匹配、日期及数组格式。修复前保留原文件，格式见 format.md。 |
| UNSAFE_PATH | 库内符号链接被拒绝；将文档存为实际文件。根目录可以是别名，子目录不能借 symlink 跳出库。 |
| EACCES / EPERM | 比较服务用户和目录所有者、文件权限；先修正正确用户的访问权限，不把整个库设成 777。Windows 检查 ACL。 |
| 删了说明又出现/没有自动恢复 | 普通重启不会恢复删除的种子；显式 init 才补缺失说明。若别的设备重新出现它，查同步是否尚未完成或产生冲突。 |

## 远程连接

| 现象 | 检查与处理 |
|---|---|
| connection refused / timeout | 先确认 VPS HTTP 服务运行、监听地址和端口，再查隧道或代理；本机 127.0.0.1:7464 不应直接从公网连接。 |
| HTTPS/TLS 错误 | 核对域名解析、证书域名、有效期和完整证书链、服务器时间；不要把跳过证书验证当作部署完成。 |
| 502 / 504 | 反向代理已收到请求，但上游可能没运行、端口错误、在另一个容器或请求超时；检查服务与代理连接。 |
| 401 | Bearer 模式缺失/错误的 Authorization，或代理没有传递头；更新服务器凭证后客户端也要更新。 |
| 403 | 检查 Host 域名是否在 allowed-host；代理是否保留了正确 Host；实际 Origin 是否在 allowed-origin。参数是 hostname 与完整 origin，格式不同。 |
| 404 | 路径或模式错误：Bearer 是 /mcp，URL 凭证是 /mcp/<token>；末尾多余 / 不匹配，错误 URL 凭证也返回 404。检查代理是否重写路径。 |
| 405 | 浏览器或 curl 默认 GET 请求到了有效入口；本服务仅接受 POST。不能把 GET 失败等同于 MCP 不可用。 |
| 406 / 415 / JSON-RPC 错误 | 使用 MCP 客户端或正确 Content-Type、Accept、JSON-RPC 请求；普通网页 GET 不是 MCP 初始化。 |
| 413 / 大请求失败 | 服务 HTTP 请求上限是 1 MiB，代理也可能有自己的限制；精简单次更新，不把原始长聊天直接塞进记忆。 |
| 客户端只支持 SSE 或要求 OAuth | 本包是 stateless Streamable HTTP，没有 legacy SSE 或 OAuth discovery；选择支持对应方式的客户端或适配网关。URL 凭证不会增加 OAuth 能力。 |
| 允许 Origin 后浏览器仍失败 | Host/Origin 允许列表不等于 CORS。本版不响应 CORS preflight；直接浏览器 JS fetch 需要另行配置合适网关。 |
| 桌面隧道能用，云端客户端不能 | 电脑的 localhost 和 SSH 隧道只有电脑能访问；云端需要能访问的 HTTPS 入口。 |
| 部署后退出 SSH 就断开 | 前台进程退出了，或用户服务没有配置开机/退出登录常驻；按 vps.md 检查服务与 lingering。 |
| secret 文件报错 | 路径必须在语料之外，文件为真实文件，内容是 64 位小写 hex；Unix 权限 0600。已有 token 不会被生成命令覆盖。 |
| 想撤销单个客户端 | 当前无逐客户端凭证/权限；轮换共享凭证会影响全部持有人。不同信任范围使用独立 root 和服务。 |

## 文件同步

| 现象 | 检查与处理 |
|---|---|
| 设备 Disconnected | 先查 Syncthing 服务、对方 Device ID、双方是否互加、设备是否暂停；再查同步地址、VPS 安全组、系统防火墙和实际监听。 |
| Connected 但没有文件传输 | 检查文件夹是否确实分享、Folder ID 是否一致、目标设备是否接受、目录是否暂停、是否为错误的 root、ignore 是否挡住了文件。 |
| 安全组放行后仍不通 | 还可能有操作系统防火墙、容器端口未映射、Syncthing 仅监听 loopback、DNS 指向 HTTP CDN 或协议端口选错。 |
| GUI 打不开，文件仍在同步 | 8384 是管理端口，不是同步端口；通过 SSH 转发管理页面，确认隧道本地端口与目标实例 GUI 端口。 |
| 首次说明产生冲突 | 两端在接收前各自 init/serve，生成了不同时间和内容的种子。比较两个版本保留一份，接收端后续先同步再启动。 |
| 添加 VPS 后原资料消失/变多 | 暂停相关写入和共享，保留现有副本；核对是否连接错库、共享了错误目录、使用 Override/Revert、或传播了删除。不要用空目录直接覆盖远端来“重置”。 |
| 某设备没有 .stignore | 该文件不同步；在那台设备运行 sync-prepare。已有自定义规则优先，检查是否有 * 把四类目录也挡住。 |
| sync-conflict 文件越来越多 | 多端同时改同一个文件且修改尚未传播。检查是否有重复实例/后台编辑，等待同步；比较冲突与规范正文后显式处理。 |
| 两台机器的文件权限不同 | 先确保各自服务用户有权限；跨 Windows/Unix 必要时按 Syncthing 文档评估 Ignore Permissions，本机 token 仍需单独保护。 |
| 笔记本睡眠/换网后不更新 | 离线、休眠或后台服务暂停期间无法传播；唤醒联网并确认服务仍运行、文件夹 Up to Date。 |
| knowledge_status healthy 但另一台没更新 | healthy 只描述当前本地文件格式和冲突。同步连接与待传状态必须查 Syncthing，不能用 healthy 代替。 |
| 误删已同步，想恢复 | 暂停写入，检查 Syncthing 文件版本和独立备份；确认恢复来源和当前共享状态再恢复。不要假设本机每次编辑都自动留有历史。 |
| 重新安装服务器 | 先保留设备配置、身份和语料备份；新身份需重新配对。收集现存副本，避免用新空库直接替换共享库。 |

## 升级、移动和退出

包升级不会升级 Node，也不会自动修改服务的 Node 路径或替换用户使用说明。固定版本的 npx 配置需要自己改版本。HTTP 服务升级后重启，已有客户端可能需要重新连接。

移动库时先停止有关写入/同步，在备份后迁移；同时更新本机 MCP、HTTP 服务 root 与 Syncthing folder path。不要仅改一个位置。

容器里的 `127.0.0.1` 指向该容器，HOME 也可能不同。选择容器监听地址和代理网络连接，持久挂载语料；凭证单独挂载到语料之外，并保留权限。此项目没有官方容器镜像。

撤销同步先解除共享，再处理本地副本；删除 npm 包不会自动删除语料或撤销远端访问。远程服务与同步服务可以独立停止。

## 验证范围

自动测试和发布验证覆盖本地/HTTP 官方 SDK 往返、格式与权限边界、独立进程并发更新、两个隔离 Syncthing 节点及安装包。本文是部署与排查指南，不表示所有发行版、云厂商、代理或第三方网页客户端都已实测。
