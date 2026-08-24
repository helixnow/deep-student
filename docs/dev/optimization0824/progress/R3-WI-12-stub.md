# R3-WI-12：Session JSONL 导出格式规范 + Rust stub

> 子代理：SA-R3-07  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-12（Session JSONL replay，本轮为设计前置：只定格式 + API 骨架，不实现、不注册 command）

## 任务范围

1. 调研 `chat_v2/repo.rs` 与 `chat_v2/headless.rs` 的消息/会话数据结构；
2. 产出导出格式规范 `docs/dev/optimization0824/WI-12-session-jsonl-spec.md`；
3. 新增 `src-tauri/src/chat_v2/session_export.rs` 骨架（export 函数签名 +
   单元测试占位）+ `mod.rs` 注册。

## 调研结论（消息结构盘点）

数据结构的单一事实源在 `chat_v2/types.rs`，`repo.rs` 只做行映射；
`headless.rs` 是现成的「后端消费会话数据」范例。要点：

| 结构 | 位置 | 对导出格式的影响 |
| --- | --- | --- |
| `ChatSession` | types.rs:365 | id/mode/title/persistStatus/metadata/tags，serde camelCase，直接嵌入 header 行 |
| `ChatMessage` | types.rs:1370 | role 仅 user/assistant；`parentId`/`supersedes` 承载编辑分支；`variants` + `activeVariantId` 承载多模型变体；`_meta` 挂 usage/contextSnapshot/技能快照 |
| `MessageBlock` | types.rs:1890 | `type` 为开放字符串（block_types 常量全集），`block_index` 被 `skip_serializing` ⇒ 顺序权威只能是 `blockIds`（规范 §5.3） |
| `Variant` | types.rs:813 | 每变体独立 blockIds/status/usage；repo 层 `variants_json` 有 64KB warn / 256KB 硬截断（repo.rs:26-28），导出必须流式逐行写 |
| `CompactionRecord` | types.rs:2922 | 摘要+逐字尾部的回放依据，独立记录类型导出 |
| `LoadSessionResponse` | types.rs:2535 | session+messages+blocks+state 的既有聚合 ⇒ 定为 round-trip 等价基准 |

关键 repo 访问器（实现轮直接复用，无需新 SQL）：`get_session_v2` /
`get_session_messages_v2`（ORDER BY time_created，即导出行序）/
`get_session_blocks_v2`（JOIN 一次拉全）/ `load_session_state_v2` /
`list_compactions_with_conn`。容错基调沿用 `row_to_message`
「解析失败降级为空、不 panic」（repo.rs:38 note_message_json_parse_failure）。

`headless.rs` 佐证两点：① 后端消费块数据的既有模式是
`get_message_blocks_v2` + 按 `block_type`/`tool_output` 过滤
（`summarize_assistant_blocks`，headless.rs:1992），导出规范的块语义与其兼容；
② headless run 产物只有 `HeadlessTurnResult.summary` 一个字符串，
完整时间线正是 WI-12 要补的缺口（R13+ 归档钩子已列入规范 §8）。

脱敏能力不必新造：`task_audit::redact_secrets`（URL 秘钥打码）与
`MessageMeta::without_skill_runtime_contents`（技能全文剥离）现成可复用。

## 格式设计决策（详见规范）

- **一行一记录 + `type` 判别**，行序状态机 `header (message block*)* compaction* footer`，
  未知 type/字段必须跳过（前向兼容），`schemaVersion=1` 只在 header 声明；
- **不定义新消息 schema**：嵌入对象直接复用 types.rs 的 serde 序列化
  （camelCase，与前端 Store / LoadSessionResponse 同构），types.rs 加字段
  导出自动跟进；
- 变体默认全量导出，`includeAllVariants=false` 时按
  `ChatMessage::get_active_block_ids` 裁剪（与前端 getDisplayBlockIds 一致）；
- 默认脱敏开启；附件只导出 `AttachmentMeta` 引用不内联 base64
  （对齐 canonical_content 设计）；
- footer 带计数做完整性校验；实现必须逐行流式写 `io::Write`。

## 产出

| 文件 | 内容 |
| --- | --- |
| `docs/dev/optimization0824/WI-12-session-jsonl-spec.md` | 格式规范 v1（记录类型、行序、字段映射、变体/脱敏语义、验收标准、后续排期） |
| `src-tauri/src/chat_v2/session_export.rs` | `SESSION_EXPORT_SCHEMA_VERSION` + `SessionExportOptions`（serde camelCase+default）+ `SessionExportSummary` + `export_session_jsonl<W: Write>` 签名（函数体 `todo!`）；2 个可运行的 options 单测 + 4 个 `#[ignore]` 验收占位测试（对应规范 §7） |
| `src-tauri/src/chat_v2/mod.rs` | +1 行 `pub mod session_export;` 注册（未 re-export、未注册 command，实现轮再接） |

## 验证

- `cargo check --lib`：通过（仅预存在告警，无新增错误/告警）；
- `cargo test --lib session_export`：2 passed / 4 ignored（占位测试按预期跳过）。

## 后续（规范 §8）

R12+ 实现 `export_session_jsonl` + round-trip 单测 + Tauri command
`chat_v2_export_session_jsonl` 与前端入口；R13+ headless/automations
运行归档钩子；import/replay 执行器另行排期。
