# Critic `_qa_flags` 预览识别

## 结论

critic 的 `flag` 与 `revise` 沿用确定性 lint 的标准 `_qa_flags` 条目形状：

```json
{"code":"llm_critic","field":"card","message":"...","severity":"warn"}
{"code":"llm_critic_revised","field":"card","message":"...","severity":"info"}
```

`parseCardQaFlags` 本来就能解析该形状；本次把两个稳定 code 固化为前端常量，并在
预览详情中按 code 使用中英文文案。这样英文界面不会直接展示 critic 当前写入的
中文审计前缀。

## 数据链修复

critic 在流式卡片首次发出后执行 CAS 写回，并递增卡片 `updated_at`。ChatAnki
收尾事件包含数据库最新卡片，但前端此前无条件以同 ID 的流式旧卡覆盖收尾卡，
可能丢失 revise 后的正文和 `_qa_flags`。

收尾合并现比较 `updated_at`：

- 后端收尾版本更新：采用后端卡片，带入 critic revise/flag 结果；
- 后端版本未更新或不可比较：继续保留前端当前卡片，避免旧快照覆盖用户编辑；
- 无同 ID 卡片：保持原有去重与追加行为。

## 边界

- 未修改 critic 引擎、裁决协议或持久化逻辑。
- 未增加新的 `_qa_flags` wire shape；普通 lint 和旧 `{field, rule, message}` 条目行为不变。
- 回归覆盖 critic 两种 code 的解析、本地化预览，以及较新收尾卡覆盖流式旧投影。
