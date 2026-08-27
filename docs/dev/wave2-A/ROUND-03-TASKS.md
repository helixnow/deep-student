# Wave2-A 第 3 轮任务卡（重放正确性与崩溃窗口）

基线枝 tip：`f94f88d1`（第 2 轮代际接线已落）。Draft PR #345。
模型：全部 `claude-fable-5-thinking-high`。禁止 sol/GPT/xhigh。禁止编译/测试执行。

## 红线

- 不碰 coordinator.rs、hooks 准入/TOCTOU、ApprovalGateHook 首位
- 不修 #122（Utf8 只加 warn 探针）
- 技能正文仍不落库（隐私：`without_skill_contents` 纪律保留），只持久化 digest + 版本
- 同文件同轮单人
- 过滤器负例测试不删

## 独占表

| # | 可写 |
|---|---|
| 1 | `persistence.rs` + 必要时 `pipeline.rs` 里 **一处**调用（compile 后、首个网络请求前） |
| 2 | `types.rs` 仅技能锚点 digest/version 字段；`docs/dev/wave2-A/r3-skill-digest-types.md` |
| 3 | `history.rs`（等 2）重放只接受同 digest |
| 4 | 新建 `src-tauri/src/chat_v2/pipeline/llm_content_crash_tests.rs` |
| 5 | 新建 `src-tauri/src/chat_v2/pipeline/skill_replay_digest_tests.rs` |
| 6 | `src-tauri/src/llm_manager/utf8_stream.rs` + `src-tauri/src/utils/sse_buffer.rs`（只加 warn） |
| 7 | 只写 `docs/dev/wave2-A/r3-adapter-parallel.md`；若抽公共核心，只建新文件 `src-tauri/src/chat_v2/pipeline/stream_filter_core.rs` 骨架+注释，不大迁移 |
| 8 | 只写 `docs/dev/wave2-A/r3-review-replay.md` |
| 9 | 只写 `docs/dev/wave2-A/r3-review-branch-copy.md`（读 repo.rs:1979+ 与新 digest 字段） |
| 10 | 追加 `docs/dev/wave2-A-ledger.md` 第 3 轮段 |

## API 合同

```rust
// SkillInjectionAnchors 增：
pub skill_content_digests: HashMap<String, String>, // skill_id -> sha256 hex
pub skill_content_rev: Option<u64>,                 // 可选版本世代

// history::rebuild_anchored_skill_messages：
// 若 anchors 带 digest 且请求正文 digest 不一致 → 不使用新正文伪装旧历史；
// warn + 跳过该技能消息，并返回「需开新 prefix generation」信号（bool 或 enum）。
// 正文缺失仍 warn（现有行为）。禁止把当前正文当旧锚点用。
```

digest 算法：对 skill_id 与正文 UTF-8 做稳定 sha256（复用 DoomLoopGuard / tool_schema_digest 骨架，不引新 crate）。

## #1 llm_content 前移

`persist_replay_sidecar` 现于 save_results（流程末）。崩溃窗口：已发 provider、sidecar 未保存。
在**当前 user 编译完成（`live_user_llm_content` 已有）且用户块行已 INSERT**（`save_user_message_immediately` 之后）到**首个网络请求之前**，轻量事务只写 user 块 `llm_content`。
不要把整份 save_results 前移。工具 round_text 仍可留在原 sidecar。
`pipeline.rs` 只加一处调用，放对时机。

## #2 / #3 技能版本化

#2 只加类型字段 + 序列化兼容（缺字段 = 旧锚点，重放侧视为「无 digest、保持旧 warn 行为」）。
#3 改 `rebuild_anchored_skill_messages` 与三个消费点（约 :158/:324/:353），digest 冲突不得静默用新正文。
可在 helpers 调 `converge`/`advance` **仅当**检测到冲突且当前在发送热路径——若不好接线，返回信号让调用方记录，不要为了切代大改 tool_loop。

## #4 / #5 测试只写不跑

#4：模拟「已发 provider、sidecar 未保存时崩溃」——断言若无前移则下一轮 history 只有裸 user；有前移则 llm_content 在。可用纯逻辑/假 repo。
#5：技能正文修改/删除后重放旧锚点：digest 变 → 不得输出新正文；删除 → warn+skip。

pipeline.rs `mod` 声明由父代理加。

## #6 Utf8 探针

`utf8_stream.rs` `error_len() == Some` 非法字节分支补 `log::warn!`（含 invalid_len、pending 长度，**不要打完整 chunk 原文**以防 PII）。
sse_buffer 若有同等吞掉 invalid 的路径也补 warn。文件头注明「#122 定位探针，不声称修复」。

## #7 双适配器

对照 `llm_adapter.rs` vs `variant_adapter.rs` 流处理平行逻辑，列清单 + 第一刀设计。不大迁移。
