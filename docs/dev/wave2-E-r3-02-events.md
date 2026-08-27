# Wave2-E 第 3 轮 #02 — CriticSummary/Stats 后端事件补全（events）

角色：0824 Wave2-E R3「CriticSummary/Stats 后端」。本轮只写代码与文档，未跑编译/测试/CI，未 commit。

## 改动范围

| 文件 | 动作 |
| --- | --- |
| `src-tauri/src/streaming_anki_service.rs` | 独占文件内改造（事件载荷构建 + 统计口径 out 参数化 + 单测） |
| `docs/dev/wave2-E-r3-02-events.md` | 本文档 |

**未改** `database/mod.rs`（`list_document_sessions` 无需动，警告计数走事件通道，不落库、无越权）。
**未改** `models.rs`（`StreamedCardPayload::TaskCompleted` 枚举变体保持原样，新字段在序列化后 merge 进 JSON，见下）。
**未回退** QA/lossless/occlusion 入库逻辑（`parse_and_save_card` 及其下游一行未动）。

## 1. CriticSummary 事件：不再手抄字段

旧 `emit_critic_summary` 手抄 8 个字段拼 `json!`，`CriticSummary` struct 后续新增的
`gold_references` / `gold_references_truncated` / `routed_config_id` / `routed_model` /
`routed_degraded` 全部漏发。

新实现（纯函数 `build_critic_summary_event`，`emit_critic_summary` 只负责 `window.emit`）：

- 对 `anki_critic::CriticSummary` 整体 `serde_json::to_value`，再 merge 进
  `task_id` / `document_id` 两个上下文键，外层仍包 `"CriticSummary"` 标签；
- struct 今后加字段自动上 wire，无需再改事件层；
- `routed_*` 三字段 struct 上带 `skip_serializing_if = "Option::is_none"`，
  路由未接通时 wire 格式与旧版**完全一致**（单测覆盖）；
- 旧前端按 key 消费，未识别的新字段安全忽略。

本轮补上 wire 的字段：`gold_references`、`gold_references_truncated`、
`routed_config_id`、`routed_model`、`routed_degraded`（后三者仅 Some 时出现）。

## 2. 统计口径 out 参数化 + 失败路径补发 GenerationStats

`stream_cards_from_ai` 原返回 `Result<StreamStats, AppError>`：任何提前 `Err`
（取消/空闲超时/网络中断/HTTP 错误）都把已累计的计数一并丢掉，失败路径无 stats 可报。

改为：签名追加 `stats: &mut StreamStats`（调用方持有），返回 `Result<(), AppError>`。
函数体内所有 `stats.xxx += 1` 均为字段访问，自动解引用，零改动。

调用方 `process_task_and_generate_cards_stream`：

- `stream_stats` 在两次调用（首发 + 结构化被拒后的 delimiter 回退重试）间由调用方持有；
  回退重试前显式 `stream_stats = StreamStats::default()` 重置（首失败发生在 HTTP
  状态检查阶段、解析之前，计数理应全零，重置是防叠加的保险）；
- **失败路径**（原 704-719 一带，现 `Err(e)` 分支）：非用户取消时，若
  `stream_stats.has_any_signal()`（任一计数非零），在 `handle_task_error` 之前补发
  `GenerationStats` 事件——部分卡片已入库/已降级错误卡的失败任务，前端可展示
  「失败但有部分产出」；
- 用户取消分支保持原样（不发终态事件，由调度层置 Paused）。

## 3. TaskCompleted 载荷：质量统计 + 带警告完成

`complete_task_successfully` 签名从 `card_count: u32` 改为 `stats: &StreamStats`
（唯一调用点同文件内）。载荷由纯函数 `build_task_completed_event` 构建：

- 基底 = 既有 `StreamedCardPayload::TaskCompleted` 的序列化结果，旧四字段
  （`task_id` / `final_status` / `total_cards_generated` / `document_id`）wire 格式不变；
- merge 进新字段（旧前端按 key 消费可忽略）：

| 新字段 | 含义 |
| --- | --- |
| `failed_cards` | 解析/校验失败、降级为错误卡的卡片数 |
| `dropped_fragments` | 不含可读文本、被直接丢弃的残片数 |
| `duplicate_cards` | DB 唯一索引去重跳过的重复卡片数 |
| `flagged_cards` | 带 `_qa_flags` 标记但仍入库的卡片数 |
| `completed_with_warnings` | 布尔；上述四计数之和 > 0 且任务成功收尾时为 `true` |

- `TaskStatus` 枚举**未加变体**（现有变体无「带警告完成」语义），`final_status`
  仍为 `"Completed"`，警告语义由 `completed_with_warnings` 字段加法承载；
- 判定逻辑收敛为 `StreamStats::has_warnings()` / `has_any_signal()` 两个方法，
  事件层与失败路径共用同一口径。

## 4. 单测（只写不跑）

`streaming_anki_service.rs` 既有 `mod tests` 末尾新增 5 个纯函数测试
（不依赖 `Window`，构建载荷即断言）：

- `critic_summary_event_contains_gold_and_routing_fields`：事件 JSON 含
  `gold_references`（=4）、`gold_references_truncated`（=1）、`routed_*` 三字段、
  merge 进的 `task_id`/`document_id`，且旧字段（`examined`/`skipped_over_budget`）未丢；
- `critic_summary_event_omits_routing_when_unrouted`：未路由时 `routed_*` 键不出现
  （旧 wire 格式回归），`gold_references` 为 0 时仍序列化；
- `task_completed_event_flags_warnings_when_dropped`：`dropped_fragments = 2` 时
  `completed_with_warnings == true`，四统计字段与旧四字段齐全；
- `task_completed_event_clean_run_has_no_warning_flag`：全零警告时
  `completed_with_warnings == false`；
- `stream_stats_warning_and_signal_predicates`：四类计数任一非零即判警告；
  仅有成功卡（无警告）时 `has_any_signal()` 仍为 true（失败路径补发口径）。

## 风险与兼容性

- 事件 wire 兼容：三处事件（`CriticSummary` / `GenerationStats` / `TaskCompleted`）
  均为旧字段不变 + 新键加法，Tauri `window.emit` 对 `serde_json::Value` 与对
  struct 的序列化产物一致；
- `stream_cards_from_ai` 是私有方法，签名改动只影响同文件两个调用点，均已更新；
- 序列化失败（理论不可能，`CriticSummary`/`StreamedCardPayload` 均为纯数据 struct）
  时降级为空对象/最小载荷并记 error 日志，不 panic、不阻断收尾。
