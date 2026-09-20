# Codex 门票设置

在「CPA 配置 → 可视化 → Codex 门票设置」中编辑以下八个选项。
所有修改进入当前页面的未保存草稿；点击页面的「保存」并确认差异后一起生效。

| 配置项 | 默认值 | 页面含义 |
| --- | --- | --- |
| enabled | false | 启用 Codex 门票 |
| ttl-seconds | 3600 秒 | 门票有效期，默认 1 小时 |
| refresh-before-seconds | 600 秒 | 到期前多久刷新，默认提前 10 分钟 |
| harvest-proxy-url | 空 | 门票采集代理；未配置时主动获取无法运行 |
| probe-interval-seconds | 60 秒（1 分钟） | 面板默认后台探测间隔，保存时显式写入 |
| attempt-timeout-seconds | 25 秒 | 单次主动获取的超时时间 |
| fail-closed | false | 开启时缺票阻止请求，关闭时缺票继续发送；有效票仍强制替换 |
| models | gpt-6-astra、gpt-5.6-sol | 参与门票处理的模型，支持换行或逗号分隔 |

`target-length` 不作为全局可编辑项。目标长度由账号属性决定：
Personal（free/plus/pro）为 292，Team/Business（team/business）为 332。
凭证列表与详情继续显示每个账号模型的目标和实际长度。

## 时间输入与保存

- 时间单位统一为秒，填写正整数。探测间隔留空并保存会写入 `probe-interval-seconds: 60`；其他时间项留空并保存会移除对应 YAML 项，使用后端默认值。
- 页面加载配置时展示已保存值；缺少时间项时展示默认值，不会仅因打开页面而写入默认项。
- 修改任一门票设置时，如果探测间隔缺失或为非正数，会在 YAML 差异中补入 `60`，避免旧版 CPA 继续使用其内置的 6 秒默认值。保存前运行中的 CPA 仍使用原配置；面板升级不会自动修改服务配置。
- 已有正数探测间隔（包括显式配置的 `6`）会保留；需要改为 1 分钟时，填写 `60` 或清空后保存。其他未修改字段、配置与注释保持原有保存语义。
- 代理使用隐藏输入，空值不会自动补代理。开启门票功能本身不会替代代理配置。
- 旧服务不支持原生门票接口时显示不支持提示，配置控件不会开放。

示例（不包含全局目标长度）：

```yaml
codex:
  turn-state-ticket:
    enabled: false
    ttl-seconds: 3600
    refresh-before-seconds: 600
    harvest-proxy-url: ""
    probe-interval-seconds: 60
    attempt-timeout-seconds: 25
    fail-closed: false
    models:
      - gpt-6-astra
      - gpt-5.6-sol
```
