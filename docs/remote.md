# 远程 MCP / Remote MCP

在常在线设备运行同一个包，远程客户端通过 Streamable HTTP 访问其 Markdown 库。没有内置托管服务；你选择服务器、域名和 TLS 入口。

Run the same package on an always-on device and connect remotely over Streamable HTTP. Hosting and HTTPS are under your control.

第一次部署自己的 VPS，先看 [vps.md](vps.md)。问题按 [troubleshooting.md](troubleshooting.md) 分层排查。只需要桌面远程访问且没有域名，可以先使用下文 SSH 隧道；云端客户端则需要它能访问的 HTTPS 入口。

## Bearer token（默认 / default）

```sh
npm install -g agent-knowledge-mcp@0.1.0

# 凭证保存到记忆库之外；命令不打印秘密，也不覆盖已有凭证
agent-knowledge-mcp token --token-file /absolute/private/path/mcp.token

agent-knowledge-mcp serve \
  --transport http \
  --root /absolute/path/to/memory \
  --token-file /absolute/private/path/mcp.token \
  --allowed-host memory.example.com
```

默认监听 `127.0.0.1:7464`，入口 `/mcp`。通过 HTTPS 反向代理发布为 `https://memory.example.com/mcp`，客户端配置 `Authorization: Bearer <token-file 中的值>`。Unix 凭证文件必须为 0600；Windows 请使用系统文件 ACL 限制读取。

The listener defaults to loopback port 7464, endpoint `/mcp`. Put an HTTPS proxy in front and configure the client with a bearer header. Protect the token file with restrictive permissions.

示例 Nginx location（放入已经配置好 TLS 的 server）：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:7464;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
    access_log off;
    error_log /dev/null;
}
```

`--allowed-host` 只填写域名，不带协议或端口。服务会拒绝未允许的 Host。Origin 默认为空名单；需要允许某浏览器客户端时，显式加 `--allowed-origin https://client.example.com`。普通 SDK/后端客户端通常不发送 Origin。

Host validation uses hostnames, without scheme or port. Origins are denied unless explicitly allowed. This service does not implement OAuth discovery or browser CORS; use a client that supports the configured authentication method, or a suitable gateway.

远程启动参数不负责常驻。请用你已有的服务管理器保持进程运行；服务需有 Node 环境、稳定的可执行路径和语料目录访问权限。

Use your platform's service manager for supervision. Keep the executable path and root stable.

## 只接受网址的客户端 / URL-only clients

部分客户端无法设置请求头。可明确启用 URL 凭证模式：

```sh
agent-knowledge-mcp serve \
  --transport http \
  --url-token \
  --root /absolute/path/to/memory \
  --token-file /absolute/private/path/mcp.token \
  --allowed-host memory.example.com
```

入口变为 `https://memory.example.com/mcp/<token>`。整个网址就是凭证，持有者可以使用全部六工具。代理使用 `location /mcp/`，保持完整路径转发，并关闭访问日志、错误日志和缓存；检查 CDN 及隧道服务也不记录该路径。服务本身不会在日志中输出秘密网址。

URL 模式的完整 location 示例（替换前面的 Bearer location）：

```nginx
location /mcp/ {
    proxy_pass http://127.0.0.1:7464;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
    client_max_body_size 1m;
    access_log off;
    error_log /dev/null;
}
```

这里 proxy_pass **不带末尾 `/`**，以保留 `/mcp/<token>` 的完整路径；改成带 URI 的形式可能替换路径前缀。[Nginx 官方说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass) 修改后先运行 `sudo nginx -t`，通过后再按现有服务方式 reload。TLS server 和证书需要先配置好，上面的 location 本身不会创建 HTTPS。

The full URL is a capability credential. Preserve the path through your proxy and disable request-path logging at every layer. This mode is opt-in; bearer headers are preferable where supported.

两种模式都默认只绑定 loopback。容器或私有网络需要时可指定 `--host 0.0.0.0`，但远端连接仍应通过加密入口。

Both modes bind to loopback by default. Override the bind address for a container or private network and keep external traffic encrypted.

<a id="ssh-tunnel"></a>
## SSH 隧道：没有域名的桌面连接

在 VPS 上以默认 loopback 启动 Bearer HTTP 服务，然后在电脑终端运行：

```sh
ssh -N -L 17464:127.0.0.1:7464 USER@VPS_IP
```

电脑的 MCP 客户端连接 `http://127.0.0.1:17464/mcp`，认证仍是 Bearer。该 HTTP 连接经 SSH 加密转发到 VPS。隧道需要持续运行，断网或退出后应重连；本地端口占用时可以换一个。

这不需要公网暴露 7464，也不需要域名。云端客户端不能使用你电脑的 localhost；给它配置该地址不会让它经过你的隧道。此隧道也不负责 Syncthing 文件复制。

<a id="verify"></a>
## 验证入口与客户端

先验证 VPS 本机服务，再验证公开 HTTPS/隧道入口，最后验证真正要使用的 MCP 客户端。这三个验证不能互相替代。

下面是 VPS 上 Bash 的 Bearer 初始化检查，凭证经 stdin 传给 curl，避免直接作为命令行参数。使用实际 token 路径；排查时关闭 shell 的命令追踪。

```sh
read -r mcp_token < "$HOME/.config/agent-knowledge-mcp/mcp.token"
printf 'header = "Authorization: Bearer %s"\n' "$mcp_token" | \
  curl --config - --silent --show-error --include \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"connection-check","version":"1"}}}' \
    http://127.0.0.1:7464/mcp
unset mcp_token
```

预期收到成功状态与 JSON-RPC `result`，包含 serverInfo/capabilities。只有 HTTP 成功而返回 JSON-RPC error，仍应继续检查。验证代理时替换为真实 HTTPS 地址；验证 SSH 隧道时在电脑本地使用其端口，并以客户端已有安全方式提供凭证。不要为了检查就把 token 打印到聊天里。

URL 模式用客户端或官方 SDK验证完整秘密 URL；不要把其值留在公开截图、shell 历史或诊断报告里。这里不提供会在命令参数中展开秘密网址的 curl 示例。

在实际客户端添加远程连接时，核对以下字段，具体配置结构以该客户端为准：

| 字段 | Bearer 模式 | URL 模式 |
|---|---|---|
| Transport | Streamable HTTP | Streamable HTTP |
| URL | https://memory.example.com/mcp | https://memory.example.com/mcp/<token> |
| Authentication | Authorization: Bearer <token> | URL 本身携带凭证；可不额外登录 |
| Host / Origin | 服务允许实际 hostname 和必要 Origin | 同左 |

连接后让 Agent 列出六工具，读取使用说明，创建一条唯一临时记忆、读取、更新、用最新 etag 删除，再确认已消失。仅看到工具列表不算写入验证；执行失败时记录错误码和检查层次。

服务器不提供 OAuth discovery 或 legacy SSE。客户端无法设置 Bearer header、又不接受带路径凭证的 HTTP 连接时，需要相应网关或其他支持的客户端；不能保证只粘贴任意网址就能兼容所有客户端。

## 撤销与边界 / Revocation and scope

停止服务可立即停止访问。更换凭证文件并重启服务后，旧凭证失效；客户端需要更新。不要把 token、秘密网址或私有语料提交到 Git。

All credential holders can read, write, and delete the whole root. There is no per-client permission model. Use separate roots/services for different trust boundaries. Rotate the credential and restart to revoke old access.

轮换时生成一个新的 private token 文件，在服务参数里改为它并重启，然后更新客户端。确认新凭证可用、旧凭证已拒绝后再清理旧文件；生成命令不会覆盖现有 token。旧 URL 不能仅靠删除聊天消息撤销，必须轮换或停止服务。

本版本使用 stateless HTTP JSON 响应，只接受 POST；不是 legacy SSE 服务。客户端功能和认证支持可能不同；已通过官方 Node MCP SDK 的真实握手和六工具往返验证，未声称验证所有网页客户端。

This is stateless Streamable HTTP with JSON responses, not legacy SSE. Verified with the official Node MCP SDK; compatibility with every hosted client is not implied.
