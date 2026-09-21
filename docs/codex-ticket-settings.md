# Codex 门票设置

在「CPA 配置 → 可视化 → Codex 门票设置」中编辑以下八个选项。
所有修改进入当前页面的未保存草稿；点击页面的「保存」并确认差异后一起生效。

| 配置项 | 默认值 | 页面含义 |
| --- | --- | --- |
| enabled | false | 启用 Codex 门票 |
| ttl-seconds | 3600 秒 | 门票有效期，默认 1 小时 |
| refresh-before-seconds | 600 秒 | 到期前多久刷新，默认提前 10 分钟 |
| harvest-proxy-url | 空 | 门票采集代理；未配置时主动获取无法运行 |
| probe-interval-seconds | 60 秒（1 分钟） | 后台探测间隔，使用 CPA 默认值 |
| attempt-timeout-seconds | 25 秒 | 单次主动获取的超时时间 |
| fail-closed | false | 开启时缺票阻止请求，关闭时缺票继续发送；有效票仍强制替换 |
| models | gpt-6-astra、gpt-5.6-sol | 参与门票处理的模型，支持换行或逗号分隔 |

`target-length` 不作为全局可编辑项。目标长度由账号属性决定：
Personal（free/plus/pro）为 292，Team/Business（team/business）为 332。
凭证列表、卡片与详情仅显示模型名和门票状态（剩余有效时间、缺失或阻止），不展示目标和实际长度。

## 时间输入与保存

- 时间单位统一为秒，填写正整数；留空并保存会移除对应 YAML 项，使用后端默认值。
- 页面加载配置时展示已保存值；缺少时间项时展示默认值，不会仅因打开页面而写入默认项。
- 修改门票设置仍使用现有 YAML 差异预览，未修改字段、其他配置与注释保持原有保存语义。
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
