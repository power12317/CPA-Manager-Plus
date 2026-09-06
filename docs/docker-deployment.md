# CPA Manager Plus Docker 部署

本仓库是 `power12317/CPA-Manager-Plus`。以下入口都运行本仓库的多实例版本。
默认 Compose 从当前源码构建；发布镜像使用 `ghcr.io/power12317/cpa-manager-plus`。
上游安装脚本及 `seakee/cpa-manager-plus` 镜像不包含本仓库的改动。

## 方式一：从仓库源码构建

需要 Docker Engine 和 Docker Compose v2.20+。

```bash
git clone https://github.com/power12317/CPA-Manager-Plus.git
cd CPA-Manager-Plus
docker compose up -d --build
docker compose logs cpa-manager-plus
```

默认 `compose.yaml` 引用源码构建配置，镜像名为 `ghcr.io/power12317/cpa-manager-plus:latest`，
`pull_policy: build` 保证构建当前检出的代码。构建包含修改后的 React 面板和 Go 后端，
面板内嵌进后端镜像。构建仍需下载 Node、Go、Alpine 基础镜像和依赖。

也可以显式使用原文件入口：

```bash
docker compose -f docker-compose.manager.yml up -d --build
```

以后更新：

```bash
git pull --ff-only
docker compose up -d --build
```

源码方式不需要等待 GHCR 发布。

## 方式二：使用自己仓库发布的镜像

推送到 `main` 后，GitHub Actions 的 **Publish Docker image** 工作流
自动构建 `linux/amd64` 和 `linux/arm64` 并发布：

```text
ghcr.io/power12317/cpa-manager-plus:latest
ghcr.io/power12317/cpa-manager-plus:sha-<完整提交 SHA>
```

工作流使用仓库自己的 `GITHUB_TOKEN`，无需配置 Docker Hub 密码。Fork 仓库如果
默认禁用 Actions，需要先在 GitHub 的 Actions 页面启用。首次发布后，若希望服务器
匿名拉取，在 GitHub Packages 中把该包的可见性设为 Public；保持 Private 时，部署端
需要先 `docker login ghcr.io`，使用有该包读取权限的令牌。

**必须等工作流成功，镜像才可用。推送代码本身不代表镜像已经发布。**

在仓库目录执行：

```bash
docker compose -f docker-compose.image.yml up -d --pull always
```

这个入口没有 `build`，只拉取自己仓库的镜像。以后更新也执行同一条命令。
若服务器只需要镜像部署，复制 `docker-compose.image.yml` 和可选的 `.env` 到固定部署目录即可。
不要同时使用两个入口启动两套采集器。

要固定或回退版本，在 `.env` 设置 `CPAMP_IMAGE` 为已发布的 `sha-...` 标签，再执行上述命令。
源码入口和镜像入口使用相同的服务名、数据卷定义；切换入口时保持同一目录和 Compose
项目名（`-p`），即可继续使用原数据。不要用 `down -v` 更新，否则会删除数据卷。

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
| `CPAMP_IMAGE` | 自己的 GHCR `latest` | 仅镜像部署入口使用 |
| `CPAMP_VERSION` | `dev` | 仅本地源码构建时的面板版本标识 |

子路径并未固定为 `/cpamp`，Nginx 示例及详细说明见[多实例部署](multi-instance.md#子路径反向代理)。

持久化卷挂载整个 `/data`，覆盖默认实例数据库、所有新增实例数据库、注册信息和
加密密钥 `data.key`。备份需要包含整个卷，使用 SQLite 一致性备份方式或停机复制。
