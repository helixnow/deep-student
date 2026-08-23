# 对话核心 SOTA 审阅：Responses 协议与提示缓存

本目录记录云端代理对 Chat V2 对话核心的持续审阅与落地进度。
目标：把 OpenAI / DeepSeek Responses 协议利用，以及多轮提示缓存前缀保护，对标
OpenCode、Pi Agent、Claude Code、Codex 的行业前沿。

## 两个核心问题

1. **Responses 适配器是原生能力利用，还是 Chat Completions 兼容层？**
   重点供应商：DeepSeek 官方 Responses、ChatGPT / OpenAI Responses（含 Codex OAuth）。
2. **技能注入、工具面、系统提示词是否会在多轮对话中切断缓存前缀？**
   这是成本与延迟的重中之重。

## 工作方式

- 父代理只做文档 / 方案记录，以及不超过 10 行且不涉及业务逻辑的直改。
- 代码落地由 `claude-fable-5-thinking-xhigh` 修复子代理在独立分支完成。
- 每轮调研结果写入本目录，并及时以 PR 提交。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [PROGRESS.md](./PROGRESS.md) | 轮次、子代理、分支与 PR 状态 |
| [ROUND-01-findings.md](./ROUND-01-findings.md) | 第一轮：父代理预审 + 子代理任务矩阵 |
| [ROUND-01-telemetry.md](./ROUND-01-telemetry.md) | 第一轮补充：各协议 cached_tokens 测量缺口 |
| [ROUND-01-opencode-pi.md](./ROUND-01-opencode-pi.md) | 第一轮补充：OpenCode / Pi 对标 |
| [ROUND-01-responses-adapter.md](./ROUND-01-responses-adapter.md) | 第一轮补充：Responses 适配器审阅 |
| [ROUND-01-cache-prefix.md](./ROUND-01-cache-prefix.md) | 第一轮补充：system/技能/DeepSeek 前缀断裂 |
| [ROUND-01-native-coverage.md](./ROUND-01-native-coverage.md) | 第一轮补充：官方字段覆盖度与 V4-Pro 门控过期 |
| [ROUND-01-tools.md](./ROUND-01-tools.md) | 第一轮补充：工具排序空操作与多变体死键 |
| [ROUND-01-prefix-paths.md](./ROUND-01-prefix-paths.md) | 第一轮补充：live/replay 分叉总表 |
| [ROUND-01-replay.md](./ROUND-01-replay.md) | 第一轮补充：V20260806 未接线，A/B 分层 |
| [DESIGN.md](./DESIGN.md) | 随调研收敛的优化方案（草案 → 可落地） |

## 当前判断（会随轮次更新）

截至第一轮父代理预审：

- Responses 路径已经不是「完全空白的兼容层」：有 `store` 默认关闭、
  GPT-5/o 系列 `include=reasoning.encrypted_content`、reasoning item 回放、
  DeepSeek 官方 `web_search` 托管工具、Codex `prompt_cache_key`。
- 主体仍是 **Chat Completions → Responses 的机械转换**。缺少
  `previous_response_id` 链式调用、非 Codex 路径的 `prompt_cache_key`、
  Responses 原生 `input_tokens_details.cached_tokens` 解析。
- 系统提示已有「稳定前缀 / 动态后缀」分层，技能以 transient user 消息插入
  历史末尾，说明团队已意识到前缀缓存。但仍有多处会切断前缀或让命中率不可见。
