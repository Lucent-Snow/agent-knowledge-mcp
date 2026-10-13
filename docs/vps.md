# 接入自己的 VPS / Bring your own VPS

这份指南面向 Linux VPS，以 Debian/Ubuntu + 普通 SSH 用户为例。先确定下面哪条路径适合自己，再按需执行。已经运行 Syncthing 或其他记忆库时，先检查现状，复用合适的配置。

Bring your own Linux VPS: choose remote access, offline replication, or both. Commands below assume a normal SSH user on Debian/Ubuntu. Replace example users, paths and addresses before using them.

## 1. 选择使用方式

| 需求 | 电脑上运行什么 | VPS 上运行什么 | 继续阅读 |
|---|---|---|---|
| 多个客户端访问同一套记忆，离线不需要用 | 支持 HTTP 的 MCP 客户端 | HTTP MCP 和唯一记忆库 | 本文第 2、3 节及 [remote.md](remote.md) |
| 每台电脑离线也能用 | 本地 stdio MCP + Syncthing | Syncthing + 一个语料副本 | 本文第 2、4 节及 [sync.md](sync.md) |
| 本地离线使用，同时让云端客户端访问 | 本地 stdio MCP + Syncthing | Syncthing + HTTP MCP，共用一个目录 | 完成第 4 节，再完成第 3 节 |

不要求 VPS 与电脑使用相同绝对路径，但各进程必须指向自己设备上的同一份语料。远程连接不会自动把服务器的资料下载到客户端。

## 2. 准备 VPS

在电脑 SSH 登录 VPS，以准备持有记忆的普通用户操作。下文的 `USER`、`VPS_IP`、`memory.example.com` 都是需要替换的示例。

```sh
ssh USER@VPS_IP
node --version
npm --version
```

Node 必须为 22 或更新版本。没有 Node 或版本太旧时，先按 [Node 官方安装说明](https://nodejs.org/en/download)安装支持版本。系统包中的 Node 不一定满足要求。

使用当前用户安装包，避免 sudo 安装出另一套用户目录：

```sh
npm install -g --prefix "$HOME/.local" agent-knowledge-mcp@0.1.0
export PATH="$HOME/.local/bin:$PATH"
agent-knowledge-mcp --version
```

如果要在之后的交互式终端中直接使用命令，把 `$HOME/.local/bin` 加入自己 shell 的 PATH。systemd 不自动读取这些 shell 配置；常驻服务将在下一节使用明确的 Node 和源码路径。

默认语料是当前用户的 `~/.agent-knowledge`。以下例子统一使用它。已有库请选择其真实路径；不要在电脑、VPS 或不同用户下无意中创建多个空库。

### 检查已有服务

准备 Syncthing 时，先查看它是否已经运行、由哪个用户运行、使用哪个配置目录。不要给已有运行实例再次启动一个相同端口的实例。

```sh
systemctl list-units --all 'syncthing*'
systemctl --user list-units --all 'syncthing*'
```

这些命令只检查 systemd 管理的实例；还应检查你使用的 Docker、其他服务管理器或直接启动的进程。MCP、Syncthing 和目录持有者最好是同一个普通用户。

## 3. VPS 作为远程记忆服务

**接收现有电脑语料的 VPS，先完成第 4 节同步，等库同步完成后再启动 HTTP MCP。** 全新远程库则可以先初始化：

```sh
agent-knowledge-mcp init --root "$HOME/.agent-knowledge"
agent-knowledge-mcp token \
  --root "$HOME/.agent-knowledge" \
  --token-file "$HOME/.config/agent-knowledge-mcp/mcp.token"
```

凭证已存在时，token 命令会拒绝覆盖。正常重启复用它；轮换见 [remote.md](remote.md)。凭证放在语料之外。

首次先在前台验证：

```sh
agent-knowledge-mcp serve \
  --transport http \
  --root "$HOME/.agent-knowledge" \
  --token-file "$HOME/.config/agent-knowledge-mcp/mcp.token" \
  --allowed-host memory.example.com
```

没有域名、只通过 SSH 隧道使用时，可以去掉 `--allowed-host`。这个命令会持续运行；stdio MCP 由客户端启动，HTTP MCP 则需要常驻。验证成功后按 Ctrl+C 结束前台进程，再配置服务。

### Linux 常驻示例

下面采用 systemd 用户服务。先查出当前环境：

```sh
command -v node
printf '%s\n' "$HOME"
mkdir -p "$HOME/.config/systemd/user"
```

将下面内容保存为 `~/.config/systemd/user/agent-knowledge-mcp.service`。替换 `/ABSOLUTE/PATH/TO/node` 和全部 `/home/USER`；若需要域名也替换它。`ExecStart` 不执行 shell，不会展开 `$HOME` 或 `~`。

```ini
[Unit]
Description=Agent Knowledge MCP
After=network.target

[Service]
Type=simple
ExecStart=/ABSOLUTE/PATH/TO/node /home/USER/.local/lib/node_modules/agent-knowledge-mcp/src/cli.mjs serve --transport http --root /home/USER/.agent-knowledge --token-file /home/USER/.config/agent-knowledge-mcp/mcp.token --allowed-host memory.example.com
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

本例安装路径与前面的 `--prefix "$HOME/.local"` 对应。已有安装方式不同时应填写实际路径；路径含空格需按 systemd 的参数引用规则调整。

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-knowledge-mcp.service
sudo loginctl enable-linger "$(id -un)"
systemctl --user status agent-knowledge-mcp.service --no-pager
journalctl --user -u agent-knowledge-mcp.service -n 50 --no-pager
```

lingering 使用户服务可以在没有 SSH 登录时运行。没有 sudo 权限时请让服务器管理员配置开机常驻，或使用已有服务管理器。不要仅用 SSH 前台进程作为长期部署。

Node 安装在版本管理器目录时，升级 Node 可能改变可执行路径，需要更新 unit、daemon-reload 并重启。包升级保持上述安装前缀。

### 连接入口

- 桌面客户端 + 没有域名：使用 [remote.md 的 SSH 隧道](remote.md#ssh-tunnel)。无需为 MCP 开公网监听。
- 云端/网页客户端：需要它能访问的 HTTPS 地址和认证方式；localhost、局域网 IP 和你电脑的 SSH 隧道无法替云端建立连接。按 [remote.md](remote.md) 配置 TLS 反向代理。
- URL-only 客户端：明确启用 `--url-token`，并把反向代理也改为保留 `/mcp/<token>` 路径的配置。更改启动参数后重启服务。

## 4. VPS 作为同步汇聚节点

### 安装并启动 Syncthing

电脑和 VPS 都需要 Syncthing。Debian/Ubuntu 可以使用系统包；也可按 [官方安装入口](https://syncthing.net/downloads/)选择适合发行版的包。

```sh
sudo apt update
sudo apt install syncthing
syncthing --version
```

对于第一次安装、没有既有实例的 VPS，以当前普通用户启用安装包提供的系统服务模板：

```sh
sudo systemctl enable --now "syncthing@$(id -un).service"
systemctl status "syncthing@$(id -un).service" --no-pager
```

如果提示没有该 unit，说明安装方式未提供模板，请按 [Syncthing 官方常驻说明](https://docs.syncthing.net/users/autostart.html#how-to-set-up-a-system-service)安装对应服务文件。使用现有用户服务时直接复用，并确认它能在退出登录后运行。不要同时启用两种服务。

### 准备接收目录

假设电脑已经有实际记忆，VPS 是新接收端：

```sh
agent-knowledge-mcp sync-prepare --root "$HOME/.agent-knowledge"
```

此时**先不运行 init 或 serve**；等待源端说明和记忆同步过来。电脑也运行一次 sync-prepare，使用电脑实际记忆目录。`.stignore` 不跨设备传播。

### 打开 VPS 的管理页面

管理页面保持默认 `127.0.0.1:8384`。在**电脑**终端执行：

```sh
ssh -N -L 18384:127.0.0.1:8384 USER@VPS_IP
```

电脑浏览器打开 `http://127.0.0.1:18384`。保留这个终端；退出后隧道关闭。若本地端口占用，可以换成另一个本地端口。这个隧道只用于管理页面，不负责长期文件复制。[官方 SSH 隧道说明](https://docs.syncthing.net/users/firewall.html#tunneling-via-ssh)

### 配对设备和文件夹

1. 在电脑和 VPS 的 Syncthing 中分别查看本机 Device ID。
2. 电脑添加 VPS 的 Device ID，VPS 添加电脑的 Device ID；核对双方身份。
3. 在电脑为真实语料添加或复用一个 **Send & Receive** 文件夹，并分享给 VPS。记住其 **Folder ID**。
4. VPS 接受这个已分享的文件夹，目录选择自己的 `~/.agent-knowledge`，保留相同 Folder ID。目录路径和 Label 可以不同。
5. 双方启用合适的文件版本保留，等待扫描和同步完成；查看设备 Connected 与文件夹 Up to Date。

Device ID 表示设备身份，Folder ID 表示同一个共享目录；只让它们名字一样不会建立共享。两边各自新建不同 Folder ID 的目录也不会自动合并。

### 公网连接

优先让电脑直接连接常在线 VPS。在电脑 Syncthing 的 VPS 设备 Addresses 中可以填写：

```text
tcp://VPS_IP:22000
```

相应地，VPS 的 Syncthing 需要监听该接口，云厂商安全组与系统防火墙允许入站 TCP 22000。如果使用 QUIC 还需要 UDP 22000。UDP 21027 是局域网发现，不需要为 VPS 直连向公网开放。自定义同步端口时相应替换。[官方端口说明](https://docs.syncthing.net/users/firewall.html)

启用的发现或中继也可能让设备连通；直连地址减少对发现的依赖，连接成功后查看实际 Connection Type。DNS/CDN 的 HTTP 代理不等于 Syncthing TCP 代理，直连应使用可达的 IP、DNS-only 域名或已配置的私有网络地址。

不要机械启用新的防火墙规则而切断现有 SSH；先确认当前 SSH 端口和已有规则。Syncthing 管理页面 8384 和 MCP 后端 7464 无需公开。

### 接入第三台设备

第三台设备安装并启动 Syncthing，准备空接收目录，与 VPS 互加设备并接受**已有 Folder ID**，等初次同步完成后再注册本地 MCP。确认源库已在 VPS 同步完成。

常在线 VPS 帮助设备在不同时间交换变更；并不要求所有设备彼此直连。VPS 自己也只是一个副本，不是自动冲突仲裁器。

## 5. 验收、日常维护与退出

按 [sync.md 的往返验证](sync.md#roundtrip)检查创建、反向更新和删除；远程 MCP 按 [remote.md 的初始化请求](remote.md#verify)验证。`knowledge_status` 只诊断语料，不代表 Syncthing 已连接或没有待传文件。

退出 SSH 后再次连接，确认服务仍 active；服务器重启后再检查。关闭某台设备期间可以本地工作，重新上线后先等待同步再处理同主题修改。

退出某设备同步时，先在 Syncthing 停止共享或移除设备/文件夹，再考虑删除本地副本；仍在共享时清空文件夹会传播删除。停止 HTTP 服务会停止远程访问，但不会停止单独运行的 Syncthing。

保留独立备份。Syncthing 版本保留主要处理它收到的远端替换和删除，不保证保留本机每次直接编辑的历史，详见 [文件版本说明](https://docs.syncthing.net/users/versioning.html)。故障时先暂停相关写入/共享，保留两端资料，再按 [troubleshooting.md](troubleshooting.md)诊断。
