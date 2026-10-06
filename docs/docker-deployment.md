# CPA Manager Plus Docker 部署

本仓库是 `power12317/CPA-Manager-Plus`，唯一 Compose 入口为 `docker-compose.yml`，
只启动独立的 CPAMP 服务。CPA 和 Codex master 使用各自项目的部署文件。

## 部署和更新

推送到 main 后，**Publish Docker image** 工作流构建 amd64、arm64 镜像并发布：

```text
ghcr.io/power12317/cpa-manager-plus:main
ghcr.io/power12317/cpa-manager-plus:latest
```

等待工作流成功后，在保存 `docker-compose.yml` 的固定目录执行：

```bash
docker compose up -d --pull always
docker compose logs cpa-manager-plus
```

以后更新也执行同一条命令。默认使用 latest，也可在 `.env` 中设置
`CPAMP_IMAGE=ghcr.io/power12317/cpa-manager-plus:main`。
不需要在部署服务器克隆源码或运行 Node/Go 构建。

只有工作流成功才表示镜像已发布。仓库自身的 GITHUB_TOKEN 用于 CI 推送，
公开 GHCR 包可匿名拉取。部署时保持同一目录和 Compose 项目名，以继续使用原数据卷；
不要用 `down -v` 更新，因为这会删除数据卷。

## 首次登录与多个 CPA

默认访问 `http://服务器IP:18317/management.html`。未指定管理员密钥时，首次启动
会生成密钥并在日志中输出一次；后续启动继续使用保存在数据卷中的认证配置。

先在 setup 配置第一个 CPA，再进入“配置面板 → CPA Manager Plus 配置 → 实例管理”
添加其他实例。

| CPA 所在位置 | 填写的 CPA 地址 |
| --- | --- |
| 同一宿主机，Docker 端口映射为 8312 | `http://host.docker.internal:8312` |
| 同一宿主机，另一个 Docker 端口为 8313 | `http://host.docker.internal:8313` |
| 另一台服务器 | `http://192.168.1.22:8317` |
| 已接入同一 Docker network | `http://cpa-01:8317` |

Compose 已提供 `host.docker.internal:host-gateway`，适配 Linux 宿主机访问。
宿主机 CPA 的映射端口需要可从 Manager 容器访问。容器里的 `127.0.0.1` 是容器自身。
此 Compose 只启动一个 Manager，不会启动或替换你已有的 CPA 容器。

## 可选配置

复制 `.env.example` 为 `.env` 后按需修改；`.env` 已从 Git 和 Docker 构建上下文排除。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CPAMP_BIND_ADDRESS` | `0.0.0.0` | 宿主机监听地址；仅供本机 Nginx 使用可填 `127.0.0.1` |
| `CPAMP_PORT` | `18317` | 宿主机访问端口 |
| `CPA_MANAGER_ADMIN_KEY` | 空 | 空值由首次启动生成；也可指定自己的长随机密钥 |
| `CPA_MANAGER_BASE_PATH` | 空 | 代理保留前缀时填 `/cpamp`；代理去除前缀时留空 |
| `USAGE_COLLECTOR_MODE` | `auto` | 采集方式；需要 HTTP 代理时可选择 `http` |
| `CPAMP_IMAGE` | 自己的 GHCR `latest` | 选择 main 或 latest 镜像 |

子路径并未固定为 `/cpamp`，Nginx 示例及详细说明见[多实例部署](multi-instance.md#子路径反向代理)。

持久化卷挂载整个 `/data`，覆盖默认实例数据库、所有新增实例数据库、注册信息和
加密密钥 `data.key`。备份需要包含整个卷，使用 SQLite 一致性备份方式或停机复制。
