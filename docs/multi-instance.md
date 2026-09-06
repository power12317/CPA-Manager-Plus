# 多 CPA 实例管理

Manager Server 支持一个控制台管理同机或跨机器的多个 CPA。浏览器只向
Manager 发送管理请求，由 Manager 使用服务端加密保存的 CPA Management Key
访问对应实例。普通 `management.html` 轻量面板仍可直接管理单个 CPA。

## 页面范围

- 仪表盘、用量分析、请求监控、凭证管理、系统信息统一使用原有页面布局，
  默认查询所有已启用实例。选择单实例只改变数据范围，不切换到另一套页面。
  凭证列表保留原有筛选、分页和批量管理功能，并标明所属实例。
- 同名凭证按所属实例分别展示。每一项操作均使用它所属的实例 ID，
  防止对其他实例的同名凭证执行操作。
- 日志、配置、OAuth、提供商及插件等页面自动使用最后添加且已启用、初始化成功的实例。
  如果已经选定实例，则沿用当前选择；通过页面顶部统一切换，不再显示整页实例选择。
  自动选择不会覆盖“所有实例”的偏好；返回仪表盘等汇总页面后继续展示全部实例。
  进入实例后可使用
  该实例的完整原有管理页面，包括凭证详情、编辑、上传、配额和重新授权。
- 顶部选择器直接切换实例，不弹确认框，也不重新加载整张网页。
  顶栏、侧栏和登录态保留，只更新内容区；请求与缓存按实例隔离，旧响应不能覆盖新实例。
  浏览器前进、后退会同步恢复实例范围。
  OAuth 发起、轮询与回调提交固定在原实例。切换会停止当前页面的轮询；
  不会把已开始的授权改绑到另一个 CPA。
- 汇总接口返回查询覆盖数量与失败实例。成功率、时间分桶和全局请求分页统一计算，
  延迟 P95 基于各实例的原始时间样本重新计算；CPA 离线不会删除已采集的历史数据。

## 添加实例

登录 Manager 后打开“配置面板 → CPA Manager Plus 配置 → 实例管理”，
或点击页面顶部的“实例管理”直达该配置标签。填写名称、完整 CPA URL 和
Management Key。连接地址必须从 Manager 的网络环境可达：

| 场景 | URL 示例 |
| --- | --- |
| Manager 在宿主机，CPA 映射到宿主机不同端口 | `http://127.0.0.1:8312` |
| 同一个 Docker network | `http://cpa-01:8317` |
| 其他服务器 | `http://192.168.10.21:8317` |
| HTTPS / 域名 | `https://cpa01.internal.example.com` |

CPA 必须允许远程管理访问。容器里的 `127.0.0.1` 指容器自身。
创建时验证管理 API、采集保留期，并开启 CPA usage publishing。
不要把同一个 CPA 通过不同域名、IP 或代理别名重复登记；同一个队列只允许
一个消费者。系统拒绝重复的规范化 URL，但不能判定不同地址是否实际指向同一 CPA。

新增实例独立启动采集、巡检、自动化和派生统计任务；一个实例的请求失败
不会改变其他实例的连接配置。编辑时密钥留空可保留原密钥。停用新增实例会
停止其任务并拒绝该实例的管理请求，已有数据保留；可以再次启用。

旧配置与旧数据库对应 `default` 兼容实例，升级不搬移或重写其 `usage_events`。
默认实例保留旧入口兼容性，不能整体停用；可以在该实例的配置页关闭采集。

## 数据与备份

```text
data/
  data.key
  usage.sqlite                   # 原实例数据 + 实例注册信息
  instances/
    <instance-id>/usage.sqlite    # 该实例独立的配置和数据
    <instance-id>/usage-imports/  # 该实例的导入会话
```

实例注册信息保存在主数据库现有 `settings` 表中，不包含 CPA 密钥。各实例的
连接密钥加密保存在自己的数据库中，使用同一份服务端 `data.key`。
备份必须覆盖主数据库、整个 `instances` 目录和 `data.key`；仅备份主数据库
不能恢复新增实例的数据。在线备份应使用 SQLite 一致性备份方式，或停机后复制。

新增实例的数据文件在 HTTP listener 启动后打开，派生统计维护在后台执行。
本次改造不对旧 `usage_events` 添加字段、回填、删除或改写。

## 子路径反向代理

推荐让 Nginx 去掉外部前缀，Manager 无需额外的路径配置。同一个构建产物
可以放在 `/cpamp/`、`/cpamc1/` 或多级子路径下。

```nginx
location = /cpamp {
    return 308 /cpamp/;
}

location ^~ /cpamp/ {
    # 结尾 / 表示去掉 /cpamp/ 前缀。
    proxy_pass http://127.0.0.1:18317/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    client_max_body_size 64m;
    proxy_buffering off;
}
```

访问 `https://example.com/cpamp/`，页面跳转与 API 都保留此前缀。
站点 `/` 可以继续由其他服务处理，不需要把根路径管理接口转发给 CPAMP。

如果代理保留前缀（`proxy_pass http://127.0.0.1:18317;` 不带结尾 `/`），
为 Manager 设置 `CPA_MANAGER_BASE_PATH=/cpamp`，或在配置文件设置
`"basePath": "/cpamp"`。不要使用 Nginx HTML 文本替换修补 URL。

实例页面 URL 形如：

```text
/cpamp/management.html#/                         # 所有实例仪表盘
/cpamp/management.html#/accounts                 # 所有实例凭证
/cpamp/api/instances/<id>/management.html#/logs  # 指定实例日志
```

所有 CPA 管理请求由后端转发，但模型推理流量、负载均衡和服务器 Docker
编排仍属于 CPA 及部署基础设施的职责。外部 OAuth 授权站点仍需浏览器访问。
第三方插件自行生成的绝对 URL 需要插件本身遵循部署路径约定。
