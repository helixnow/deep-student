# Wave2-A 第 5 轮任务卡（遥测 + provider 协议 + 架构结论）

枝 tip：`2d70b400`。模型全是 `claude-fable-5-thinking-high`。禁止编译/测试执行。

同文件同轮单人：`model2_pipeline.rs` 只给 #1；`providers/mod.rs` 只给 #2。

| # | 可写 |
|---|---|
| 1 | `model2_pipeline.rs` + 若必须则 `llm_usage` 写入路径：遥测身份 + prefix 指纹 + P6 retention 裁决 |
| 2 | `providers/mod.rs`：P0 快照钉死 + P1 状态机补测源码 + P2 四槽/工具 marker |
| 3 | `scripts/cache-hit-report.py` |
| 4 | `docs/dev/wave2-A-agent-architecture.md`（架构结论，可新建） |
| 5 | 只写 `r5-review-model2.md` |
| 6 | 只写 `r5-review-providers.md` |
| 7 | 只写 `r5-review-arch.md` |
| 8 | leftover：history digest 冲突切代信号（`history.rs` 最小） |
| 9 | leftover：TauriAdapter 消费 pending generation（仅 TS 该段） |
| 10 | 追加 ledger 第 5 轮 |

## #1 model2 三件事

1. **遥测身份**：`record_llm_usage_cache_ext` 不要把随机 `stream_event` 当 session_id。分列 session_id / variant_id / run_id。从 `chat_v2_session_scope_and_generation` 解析真实 session。扩展 llm_usage 表字段若需改 migration：**加法**新列，不改旧 migration 文件。
2. **prefix 指纹**：CHAT_V2_CACHE_DEBUG 改为 post-adapter 最终 body，按 system / tools / history / current-user 四段取指纹，记录首个分叉段。
3. **P6 retention**：优先**删除**死实现；若接线则 GPT-5.6+ 必须 `ttl:"30m"`（禁止 24h），且仅官方 OpenAI 端点。写快照测试源码（只写不跑）。

## #2 provider

- P0 已修：补三类快照测试源码（官方 GPT-5.6 / 第三方同名 / 偶含 gpt-6 字样）——若已有则核补缺口
- P1 include_usage：choice 完成 ≠ 流完成；补完整事件序列测试源码
- P1 stream_options：已有门控则钉死测试
- P2：**落地修复**四槽预算 + 工具 marker 死分支（`convert_tool_definition` 不要恒 None；has_marker 必须可达）。边界测试只写不跑。

## #3 报告脚本

按新列分组；修正多变体 steady 统计（不要把 stream_event 当 session）。缺列时降级。

## #4 架构结论

契合度矩阵定稿：会话内工具面 append-only、system 稳定前缀、子代理 prompt 复用母前缀（本仓是独立 session+继承档，写清「不复用母前缀是业界共识」）。后续路线。不要标 Goal complete。

## #8 leftover

digest mismatch 返回需切代信号；若在发送热路径，调用 converge/记录即可，不要大改 tool_loop。

## #9 leftover

TauriAdapter 的 persisted 集合带 generation；看到 pending 时允许再 freeze 兑现换代。first-write-wins 不回退。
