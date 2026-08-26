model=gpt-5.6-sol-xhigh-fast
# 12 — Anki WARN 相对 v0.9.44 的回归归因

## 结论

**WARN。** 04 报告的三项 WARN 中，`enableQaPass=false` 仍写
`_qa_flags` 是 **0824 引入**；“恢复卡住任务”的 1 小时/待处理文案与后端
10 分钟/`Paused` 不一致，以及“保存到卡库”死 key，均为 **既有**，0824
未加重。没有一项应归为“0824 加重”。

| 项目 | 相对 v0.9.44 判定 |
| --- | --- |
| `enableQaPass=false` 仍写 `_qa_flags` | **0824 引入** |
| 恢复文案 1 小时/待处理 vs 后端 10 分钟/`Paused` | **既有（0824 未加重）** |
| “保存到卡库”死 key | **既有（0824 未加重）** |

**本轮不改代码。**

## 逐项对照

### 1. `enableQaPass=false` 仍写 `_qa_flags`：0824 引入

- v0.9.44 全树对 `enableQaPass`、`enable_qa_pass`、`_qa_flags` 的精确检索均为
  零命中；其 `streaming_anki_service.rs` 与技能 schema 尚无这套开关和确定性
  lint 协议，因此基线不存在该不一致。
- 0824 的公开 schema 明称传 `false` 是“不要 QA 留痕”（
  `src/features/chat/skills/builtin/index.ts:283-287,374-378`）。
- 实现先在 `src-tauri/src/streaming_anki_service.rs:1904-1907` 删除已有
  `_qa_flags`，却在 `1944-1968` 无条件执行单卡及文档级 lint，并由
  `merge_flags` 重新写入。

所以这是新增 QA 能力同时带入的开关契约缺口，判为 **0824 引入**，不是对旧问题的
加重。

### 2. 恢复卡住任务文案错配：既有

- v0.9.44 的 `src/locales/zh-CN/anki.json:777` 已写“超过 1 小时”并称重置为
  “待处理状态”；同版 `src-tauri/src/database/mod.rs:7276-7320` 已默认使用
  10 分钟阈值并将命中任务写成 `Paused`。
- 0824 仍是同一组语义：前端文案见
  `src/locales/zh-CN/anki.json:780`，后端 10 分钟与 `Paused` 见
  `src-tauri/src/database/mod.rs:7300-7344`。

阈值和目标状态的矛盾在 v0.9.44 已完整存在，0824 未扩大偏差，判为
**既有（0824 未加重）**。

### 3. “保存到卡库”死 key：既有

- v0.9.44 已有中英文
  `debug.chat_anki_panel.action.save`：中文位于
  `src/locales/zh-CN/common.json:3098-3150`，英文位于
  `src/locales/en-US/common.json:3155-3207`。
- 对 v0.9.44 发布树检索 `chat_anki_panel`，命中仅限中英文 locale 中的该分组及
  对应插件名称/描述，没有 TS/TSX 消费者。
- 0824 仍只保留 locale 条目（
  `src/locales/zh-CN/common.json:3151`、
  `src/locales/en-US/common.json:3208`）；04 报告的现树源码检索同样没有消费者。

该键在基线已经是不可达残留，0824 既未引入也未使其影响扩大，判为
**既有（0824 未加重）**。
