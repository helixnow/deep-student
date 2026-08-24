# R4-WI-12：Session JSONL 导出实现落地

> 子代理：SA-R4-02  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-12（Session JSONL replay，本轮把 R3 的格式规范 + stub
> 做成可用实现：`export_session_jsonl` + 单测 + Tauri command）

## 任务范围

1. 按 `WI-12-session-jsonl-spec.md` 实现 `export_session_jsonl`
   （默认脱敏，逐行流式写出）；
2. 补齐单元测试（替换 R3 的 4 个 `#[ignore]` 占位，覆盖规范 §7 验收标准）；
3. 注册 Tauri command `chat_v2_export_session_jsonl`；
4. spec 状态从 Draft 标为 Implemented。

## 实现要点（`src-tauri/src/chat_v2/session_export.rs`）

- **行序状态机** `header (message block*)* compaction* footer` 逐行流式写出
  （`io::Write` + 每行后即写 `\n`，禁止整文件缓冲）；块数据按消息逐条加载
  （`get_message_blocks_with_conn`，SQL 层 `block_index` 升序），块内存峰值
  O(单条消息)，满足 §7.4；
- **单一事实源**：嵌入对象（session / message / block / compaction / state）
  直接复用 `types.rs` 的 serde 序列化，不另定义消息 schema；`types.rs`
  加字段导出自动跟进；
- **默认脱敏（§5.2）**：`task_audit::redact_secrets` 对每个嵌入对象递归打码
  （秘钥字段值 + URL 内 password/token）；`_meta` 与各变体 meta 经
  `without_skill_runtime_contents` 剥离技能全文快照；附件剥离 `previewUrl`
  （不内联 base64）。`redactSecrets=false` 仅供本机调试，此时导出与
  `load_session_full_v2` 严格 round-trip 等价；
- **变体裁剪（§5.1）**：`includeAllVariants=false` 时 `variants` 数组裁剪为
  激活项，块行按 `get_active_block_ids` 过滤（与前端 `getDisplayBlockIds`
  一致），找不到激活项时回退主干 `blockIds`；
- **容错（§5.3）**：`blockIds` 引用但 DB 缺失的块跳过并 `log::warn`，
  不中断导出；会话不存在 ⇒ `SessionNotFound`；写失败 ⇒ `IoError`；
- 按 repo 惯例补了 `export_session_jsonl_with_conn` 连接级变体，
  公开函数取一次连接后委托，避免逐消息重复取池化连接。

## Tauri command（`handlers/export_handlers.rs`）

`chat_v2_export_session_jsonl(session_id, target_path, options?) ->
SessionExportSummary`：

- 会话 ID 前缀校验与既有 `chat_v2_export_session` 一致（抽出共用
  `validate_session_id`）；`target_path` 须以 `.jsonl` 结尾；
- `File::create` + `BufWriter` 流式落盘，返回与 footer 一致的计数摘要；
- 已在 `handlers/mod.rs` 重导出、`lib.rs` `generate_handler!` 注册，并同步
  `permissions/application-commands.toml`（build.rs 的 app ACL 校验强制同步）。
- 前端菜单入口仍属后续排期（见 spec §8），本轮不改前端。

## 单元测试（`cargo test --lib session_export`，10 个全过）

| 测试 | 对应验收 |
| --- | --- |
| `default_options_match_spec_defaults` / `options_deserialize_from_partial_camel_case_json` | options 契约（R3 已有，保留） |
| `export_line_order_and_footer_counts` | §7.1 行序状态机 + footer 计数 + summary/bytes_written 一致 |
| `export_round_trips_against_load_session_full` | §7.2 redact 关闭时与 `load_session_full_v2` serde JSON 等价 |
| `export_redacts_secrets_by_default` | §7.3 apiKey/URL password/URL token 打码、技能全文剥离、previewUrl 剥离、非敏感内容保留 |
| `export_active_variant_only_prunes_variants_and_blocks` | §5.1 变体裁剪 |
| `export_missing_session_returns_session_not_found` | §6 错误契约（且不写出任何行） |
| `export_skips_missing_referenced_blocks` | §5.3 缺块容错 |
| `export_honors_state_and_compaction_toggles` | options 各开关生效 |
| `export_write_failure_maps_to_io_error` | §6 IoError 映射 |

测试基建走生产一致迁移路径（`MigrationCoordinator::migrate_single(ChatV2)` +
临时目录 `ChatV2Database`，与 `session_executor` 测试同款），夹具为
「双变体 + 秘钥工具块 + 附件 base64 预览 + 会话状态 + 压缩记录」的富会话。

## 其他改动

| 文件 | 内容 |
| --- | --- |
| `docs/dev/optimization0824/WI-12-session-jsonl-spec.md` | 状态 Draft → Implemented；§6 标已实现（含 command 形态）；§8 排期表打勾 |
| `src-tauri/permissions/application-commands.toml` | +`chat_v2_export_session_jsonl`（ACL 同步） |

未触碰 `model2_pipeline` / `tool_loop` / `tsconfig`。

## 验证

- `cargo check --lib`：通过（22 个预存在告警，无新增）；
- `cargo test --lib session_export`：10 passed / 0 failed / 0 ignored。
