# oailb 借用：CPA 实验功能与 CPAMP 对接

本功能在 CPA `codex/oailb-borrow` 测试分支开发，不默认合入 main。CPAMP 的适配由其项目开发负责，使用独立测试分支。

## 最终规则

- 在当前实例的 Codex Header Defaults 内选择来源实例，再选择该实例的一份启用的 Codex OAuth 凭据，默认不借用。
- 当前实例保存来源连接地址、管理密码、稳定凭据 ID 和展示信息；不依赖 CPAMP 持续运行。
- 仅覆盖 `https://chatgpt.com/backend-api/codex/responses` 的 HTTP/SSE 请求以及对应 WSS 握手中的 `__oailb` 和 `__cflb`。
- 除这两项外，其他 Cookie 保持当前实例当前凭据自己的值。本地 Jar 始终正常接收上游 Set-Cookie；借用值不写入本地 Jar。
- `__cflb` 作为普通 Cookie 同次借用，不解析 JWT、不额外设置或校验有效期。已有借用值不因 `__oailb` 的 JWT 到期而失效，网络获取失败保留已有值；来源成功返回缺少 `cflb` 时，恢复该项本地 Cookie。
- `__oailb` 只解析 JWT `exp`。`exp - 300 秒` 前固定复用；从该时刻开始按请求尝试刷新；刷新失败时旧值可继续用到 `exp`；到 `exp` 后使用本地 Jar。
- 不另外保存 Cookie 生成时间或到期时间，不解析 JWT host 作为请求地址，不修改 JWT。
- 某一项没有可用借用值时使用该项本地 Cookie，不因借用失败阻断模型请求。`__oailb` 的过期检查不套用到 `__cflb`。
- 获取最多等待 3 秒，失败或仍在刷新窗口时最多每 30 秒尝试一次，同来源并发获取合并。
- 来源只读取指定凭据的本地 Jar，缺失或进入刷新窗口时按需请求 usage。无需开启 turn-state。既有 16 分钟 usage 刷新保持。
- 不登记借出用途，不建立后台刷新/保活任务，不共享来源 OAuth token、其他 Cookie 或整个 Jar。
- WebSocket 仅在首次建立连接或原有机制重连时检查、刷新和携带借用 Cookie。健康连接持续复用，Cookie 到期、借用值变化或借用配置变化都不会主动断开；后续 response.create/steer 不触发借用获取。SSE 仍按每次 HTTP 请求检查。

## CPAMP 页面与保存

当前页面已经属于实例 5，因此只有“来源实例 → 来源凭据”两级选择，没有再选择借用方的控件。多个实例可以分别配置同一个来源。

1. 从 CPAMP 的实例列表选择来源，排除当前实例。
2. 通过已有凭据接口 `/v0/management/auth-files` 读取来源凭据。
3. 使用 `provider=codex`、OAuth、未禁用的凭据。展示 `name`/凭据文件名，提交稳定 `id`，不得提交列表序号或 `auth_index`。
4. Manager 后端解析已保存来源连接的真实管理密码，下发给当前 CPA。浏览器不用再次输入来源密码，也不需要接收密码。
5. 保存成功后显示选中的来源实例与凭据；来源变更时必须重新选择该来源的凭据。
6. 关闭使用空对象 `{}`。该修改只作用于当前实例。
7. 能力接口为 404/405/501 时视为旧 CPA 不支持；不要影响现有 Header Defaults 和其他配置。

## 读取能力和设置

`GET /v0/management/codex-oailb-borrow`

沿用当前实例管理鉴权。无配置：

```json
{"supported":true,"config":null}
```

已配置：

```json
{
  "supported": true,
  "config": {
    "source-instance-id": "instance-9",
    "source-url": "https://cpa9.example.com/prefix",
    "source-management-key": "enc:v1:<nonce>:<ciphertext>",
    "source-auth-id": "<auth-files 返回的 id>",
    "source-auth-file": "codex-user-windows.json"
  }
}
```

Manager 给选择器返回来源 ID、凭据 ID/文件名即可，不把来源密码返回给浏览器。CPA 的密文可以原样往返。

## 保存设置

`PUT /v0/management/codex-oailb-borrow`

请求体为上述 `config` 对象本身，使用连字符字段名。配置来源时必须提供 `source-url`、`source-management-key`、`source-auth-id`。

```json
{
  "source-instance-id": "instance-9",
  "source-url": "https://cpa9.example.com/prefix",
  "source-management-key": "<Manager 取得的来源实例管理密码>",
  "source-auth-id": "<来源凭据 id>",
  "source-auth-file": "codex-user-windows.json"
}
```

关闭请求体：`{}`。成功响应：`{"status":"ok"}`。

配置在当前实例的 `codex-header-defaults.oailb-borrow` 下保存；`GET /config` 和 `GET/PUT /config.yaml` 同样支持。YAML 编辑器原样保留密文；提交明文时 CPA 在落盘前加密。

密码使用 AES-256-GCM，格式 `enc:v1:<base64 nonce>:<base64 ciphertext+tag>`。CPA 自动在持久化 auth-dir 中创建 `.oailb-data-key`，文件权限 0600。不使用管理密码的 bcrypt 哈希，也不复制 CPAMP 密文或共享 CPAMP 数据密钥。部署迁移时保留当前实例的 auth-dir。读取不到解密密钥时运行请求回退本地 Jar。

`source-url` 支持实例根地址、反向代理子路径，也兼容以 `/v0/management` 结尾的地址。该地址必须能由借用方 CPA 访问。

## CPA 之间的借出接口

`POST /v0/management/codex/oailb/borrow`

使用来源实例的管理鉴权，远程访问遵循现有管理访问策略。

```json
{"auth_id":"<指定凭据 id>"}
```

有效响应：

```json
{
  "available": true,
  "value": "<__oailb JWT>",
  "cflb": "<__cflb 值>",
  "expires_at": "2026-09-26T12:00:00Z",
  "remaining_seconds": 1800
}
```

两项都不可用时响应：`{"available":false}`。仅 `__cflb` 可用时返回 `available:true`、`value:""` 和 `cflb`，不返回 JWT 时间字段。旧版本没有 `cflb` 字段时仍兼容。`__oailb` 的最终有效性由借用方解析 JWT `exp` 判定；返回时间字段只供接口使用，不另作续期依据。再次读取不会延长 JWT。

该接口不供前端展示 Cookie。没有可借值时仅按需尝试 usage 刷新，不触发门票探测、不创建常驻任务。来源凭据必须精确匹配，找不到时不得替换成其他凭据。

## 验收重点

- 当前实例保存选择，其他实例配置不变；来源凭据切换、清空及旧版兼容正常。
- 配置文件不保存来源管理密码明文，重启后可解密，YAML 往返不丢其他配置和注释。
- exp-300 前不频繁拉取；缓冲期获取失败保留旧 JWT；exp 后回退本地；恢复后重新借用。
- HTTP 实际发送的每个已借用 Cookie 名称只有一个值，`__cf_bm` 等其他本地 Cookie 保留，响应 Cookie 更新不覆盖借用缓存。
- WSS 握手与 HTTP 使用同一个借用缓存；已建立的普通/topic/双工连接不因 Cookie 到期或借用变化而重连，也不额外访问来源接口。自然重连时使用当时有效的借用值或本地 Jar。
- 来源端只刷新选中凭据；未开启 turn-state 时 usage 按需刷新仍可工作。
- 测试仅用本地模拟上游，不调用真实账号或 ChatGPT 模型。

## CPAMP 适配入口

实验分支：`codex/oailb-borrow`。控台入口为单实例配置 → Codex Header Defaults →「oailb 借用」，使用独立的「保存借用设置」按钮。

Manager 提供以下管理员接口，前缀随部署路径保留：

- `GET /api/instances/{当前实例ID}/oailb-borrow`：读取能力与设置，仅返回 `supported`、`configured`、来源实例 ID、稳定凭据 ID 与文件名。
- `GET /api/instances/{当前实例ID}/oailb-borrow/credentials?source={来源实例ID}`：返回来源实例中启用的 Codex OAuth 文件的 `id`、`name`。自身实例、无稳定 ID、重复 ID、API Key 和运行时虚拟凭据不可选。
- `PUT /api/instances/{当前实例ID}/oailb-borrow`：浏览器仅提交 `sourceInstanceId`、`sourceAuthId`。两者为空时关闭；Manager 下发给 CPA 的关闭请求为 `{}`。

保存时再次验证来源和凭据，使用 Manager 已保存的真实连接密码，由目标 CPA 自行加密。前端不提交来源地址、管理密码或密文，也不接收 Cookie。设置与凭据读取均不触发 Cookie 借出接口；配置变更不会安排 Manager 后台任务。

该操作与配置文件保存共用互斥保护，保存后刷新当前实例的 YAML 快照，保留其他尚未保存的可视化修改。源码有未保存修改时需先处理源码；快照读取失败时阻止保存过期源码。来源切换需重新选择凭据，切换当前实例会取消旧请求。

CPA 内置面板没有 Manager 实例列表，因此显示通过 CPAMP 配置的说明；已有 `oailb-borrow` YAML 与 CPA 密文仍按原样保留。单实例的其他设置不受借用能力缺失影响。

## 节点日志与请求监控增量

CPA 现有 usage/request 记录增加可选字段 `oailb_node`，例如 `"unified-96"`；无值时为空或省略，旧实例兼容。字段沿现有 HTTP、Redis/RESP 队列及插件 usage 记录传递，不新建独立记录系统。

- 从响应 `Set-Cookie` 的 `__oailb` JWT 中提取 `host`，响应没有该 Cookie 时使用实际发送的请求 Cookie。响应明确携带 Cookie 但无法解析有效节点时留空。
- `chat.gateway.unified-96.api.openai.com` 只记录 `unified-96`；节点仅接受 1～63 位 DNS 单标签，小写字母、数字和内部连字符，不保存完整 JWT 或完整域名。
- HTTP 使用最终合成后的实际 Cookie，包含借用覆盖结果；失败响应遵循相同优先级。WebSocket 在握手时保存短节点名，后续复用连接及双工请求沿用该连接节点，不读取最新 Jar 或借用缓存推测节点，不因 Cookie 变化重连。
- 正常 Gin 请求日志在同一行追加 `oailb_node=unified-96`，不额外产生日志行；CPAMP 日志页提取该字段，在结构化日志中展示节点，保留原始日志和原有筛选行为。
- CPAMP 在原有 `usage_events` 表增加可空 `oailb_node TEXT` 字段，沿用有界 schema 初始化；无扫描、回填、新索引、重建或历史清理。旧记录保留 NULL，缺失时不显示节点行。
- 采集、导入、普通/投影监控查询、兼容用量接口、JSONL 与内部归档贯通同一字段。节点不参与请求去重键或用量汇总分组，实例归属仍沿用原有隔离规则。
- 请求监控在状态单元格增加一行节点名，长名称省略展示、悬停显示完整短节点名。CPA 内置面板用量和完整 Manager 模式均支持，四种语言文案同步。

请求事件示例：

```json
{"request_id":"...","model":"gpt-6-astra","response_model":"gpt-6-astra","turn_state_len":"292/0","oailb_node":"unified-96"}
```

## CPAMP 实验分支 Docker 镜像

推送 `codex/oailb-borrow` 分支会自动运行 `Publish oailb borrowing branch image`，使用仓库当前提交的前端和 Manager Server 源码，构建 Linux amd64/arm64 镜像。无需推送 Git tag。

- 独立实验镜像：`ghcr.io/power12317/cpa-manager-plus-oailb-borrow:latest`。
- 固定提交镜像：`ghcr.io/power12317/cpa-manager-plus-oailb-borrow:sha-<完整提交 SHA>`。
- 此工作流所有标签都属于独立的 `cpa-manager-plus-oailb-borrow` 镜像，不发布到正式镜像 `ghcr.io/power12317/cpa-manager-plus`。正式镜像的 `latest` 仍由 `main` 的原工作流管理。
- 手动执行也仅允许本 fork 的 `codex/oailb-borrow` 分支。

已有 Docker Compose 部署测试版时，将服务的 `image` 改为独立实验镜像，保留现有端口、数据卷与配置：

```yaml
image: ghcr.io/power12317/cpa-manager-plus-oailb-borrow:latest
```

首次发布的新 GHCR 包如为私有，需要在 GitHub Packages 中将该独立包设为 Public，才能匿名拉取。
