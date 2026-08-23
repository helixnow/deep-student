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
| [ROUND-01-pipeline.md](./ROUND-01-pipeline.md) | 第一轮补充：变体混拼、workspace 注入、分支复制 |
| [ROUND-01-codex-claude.md](./ROUND-01-codex-claude.md) | 第二轮：Claude Code / Codex 交叉验证 |
| [DESIGN.md](./DESIGN.md) | 随调研收敛的优化方案 |
| [ROUND-02-synthesis.md](./ROUND-02-synthesis.md) | 第一轮全部完成后的冻结落地顺序 |

## 当前判断（会随轮次更新）

第一轮 12 个切片已完成，方案冻结见 [ROUND-02-synthesis.md](./ROUND-02-synthesis.md)。

- 高质量 CC→Responses 转换层 + 局部原生（encrypted reasoning、DeepSeek web_search、`store:false`）。
- 跟 Codex 无状态路线，不默认上 `previous_response_id`。
- 跨轮缓存当前基本看不见、也基本打不中：usage 漏读、V20260806 未接线、system 动态段在历史前面。
