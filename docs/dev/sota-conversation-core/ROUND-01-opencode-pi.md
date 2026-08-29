# 第一轮补充：OpenCode / Pi 对标

来源：[OpenCode Pi comparison](1fbd7859-a620-44eb-a054-439a5834af8a)

## 对我们方案的修正

- 不是「只会做兼容层」。稳定前缀分层、工具字母序、技能治理、encrypted reasoning 回放已有设计意图。
- 短板在请求参数与注入位置：`prompt_cache_key` 只覆盖 Codex；技能瞬态消息每轮删了再插，前缀在旧插入点分叉。
- DeepSeek 仍按官方无状态处理：不要为它对齐 OpenCode 的 `previous_response_id`。
- OpenAI `prompt_cache_key` 全路径、技能锚定、动态后缀移出 system，与既有 DESIGN 一致，优先级上调。

## 对标后新增的可落地点

1. 技能改为「首次注入后位置冻结」，或把正文放进 `load_skills` 工具结果驻留 transcript（OpenCode/Pi 做法）。
2. tools 排序从纯字母序改为「首见轮次 + 字母序」，避免新工具插进中间打断后半段。
3. Anthropic：4 断点预算（tools → system → 历史尾部 2 条），对标 OpenCode `applyCaching`。
4. OpenAI 可选 `store:true` + `previous_response_id` 增量发送，compaction/失败重置链（OpenCode PR #37507）。DeepSeek 不做。
5. Pi 的 `prompt_cache_retention: 24h`、session 亲和 header、deferred tools：OpenAI 路径二期评估；DeepSeek 无效。
6. `prompt_builder` 加跨轮稳定前缀快照测试，防止时间戳再次进入前缀（OpenCode midnight-date 事故）。
