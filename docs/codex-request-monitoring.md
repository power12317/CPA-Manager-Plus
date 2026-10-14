# Codex 节点与响应模型记录

CPAMP 沿用既有请求记录展示 CPA 上报的节点和实际响应模型，同时保留多实例归属。

## 节点字段

- 可选 JSON 字段为 `oailb_node`，示例 `"unified-195"`。旧版 CPA 缺失该字段或上报空值时，页面不显示节点行。
- CPA 从响应 `Set-Cookie.__oailb` 的 JWT `host` 提取节点；只有响应没有该 Cookie 时，才使用实际请求 Cookie。响应存在 Cookie 但节点解析失败时留空。
- `chat.gateway.unified-195.api.openai.com` 只记录 `unified-195`。CPAMP 接受 1～63 位 DNS 单标签，规范化为小写；拒绝完整域名、JWT 和非法字符。
- WebSocket 后续请求沿用实际握手确定的节点，CPAMP 不读取当前 Cookie 或其他实例状态推测节点。
- 节点贯通 HTTP/RESP 采集、导入、现有 `usage_events` 记录、普通/投影监控查询、兼容用量接口、JSONL 和内部归档。节点不参与请求去重键或用量分组。
- 请求监控在状态单元格增加节点行；长名称省略显示，悬停显示完整短节点名。完整 Manager 模式和 CPA 内置面板均支持。
- 存储只增加可空 `oailb_node TEXT` 列，沿用有界 schema 初始化；不扫描或回填历史、不重建派生数据、不新增索引和维护脚本。

## 文本日志

新版 Codex 日志列顺序：

```text
[时间] [请求ID] [凭据文件] [session8] [turn8] [info ] [gin_logger.go:行号] 200 | 12.884s | unified-195 | gpt-6-sol/gpt-6-sol | 780/780 | 172.25.0.1 | POST "/v1/responses"
```

节点位于耗时之后，未知节点为 `-`。CPAMP 同时兼容旧版尾部 `oailb_node=...` 与无节点日志。按完整列布局解析，避免把模型对、turn-state、IP 或其他标识当成节点；凭据/session/turn 上下文和模型对原文保留，原始日志、复制、下载与筛选沿用既有行为。

## 实际响应模型

`response_model` 使用 CPA 上报的上游实际模型。CPA 在后续 turn-state 和请求结束更新时保留已解析的模型，每次新的上游尝试重新确定响应模型。CPAMP 原样展示该值；缺失时留空，不用请求模型或配置模型补造响应模型。

本功能只记录和展示请求元数据，不包含 Cookie 借用配置、来源凭据选择或跨实例借用 API。
