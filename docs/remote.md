# 远程 MCP / Remote MCP

在常在线设备运行同一个包，远程客户端通过 Streamable HTTP 访问其 Markdown 库。没有内置托管服务；你选择服务器、域名和 TLS 入口。

Run the same package on an always-on device and connect remotely over Streamable HTTP. Hosting and HTTPS are under your control.

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

The full URL is a capability credential. Preserve the path through your proxy and disable request-path logging at every layer. This mode is opt-in; bearer headers are preferable where supported.

两种模式都默认只绑定 loopback。容器或私有网络需要时可指定 `--host 0.0.0.0`，但远端连接仍应通过加密入口。

Both modes bind to loopback by default. Override the bind address for a container or private network and keep external traffic encrypted.

## 撤销与边界 / Revocation and scope

停止服务可立即停止访问。更换凭证文件并重启服务后，旧凭证失效；客户端需要更新。不要把 token、秘密网址或私有语料提交到 Git。

All credential holders can read, write, and delete the whole root. There is no per-client permission model. Use separate roots/services for different trust boundaries. Rotate the credential and restart to revoke old access.

本版本使用 stateless HTTP JSON 响应，只接受 POST；不是 legacy SSE 服务。客户端功能和认证支持可能不同；已通过官方 Node MCP SDK 的真实握手和六工具往返验证，未声称验证所有网页客户端。

This is stateless Streamable HTTP with JSON responses, not legacy SSE. Verified with the official Node MCP SDK; compatibility with every hosted client is not implied.
