# Wave2-A R9：死代码静态扫描

## 范围与口径

- 扫描：`tool_loop.rs`（不含文件头）、`hooks.rs`、`helpers.rs`、
  `multi_variant.rs`、`providers/mod.rs` 的 prompt-cache 段、
  `model_special_tokens.rs`、`pipeline/{llm_adapter,variant_adapter}.rs`，
  以及 `TauriAdapter.ts` 的 available-skills snapshot 段。
- 按任务约束未扫描 `history.rs`、`stream_filter_core.rs`、
  `tool_loop.rs:1-39`；未删除函数或序列化字段，未改产品逻辑。
- “生产无调用”以全仓静态符号检索为准；测试、注释、定义自身不算生产调用。
  本轮禁止测试，以下不是编译器 / clippy 结论。

## 生产无调用清单

| 位置 | 符号 | 静态调用情况 |
| --- | --- | --- |
| `tool_loop.rs:3691` | `run_bounded_ordered` | 生产零调用；仅 `parallel_exec_tests.rs` 调用。生产并行段直接使用同形的 `buffered` 组合子。 |
| `hooks.rs:114` | `PipelineHook::name` | 仅内联测试 `default_hooks_keep_approval_gate_first` 调用，用于核对钩子顺序；生产不调用该 trait 方法。 |
| `hooks.rs:1075` | `approval_manager_required` | 仅 hooks 内联测试调用；真实准入路径不调用该 helper。 |
| `helpers.rs:243` | `normalize_tool_name_for_api` | 仅 helpers 内联测试调用；生产 schema 路径直接走 canonical tool helper。 |
| `helpers.rs:373` | `approval_scope_setting_key` | 除定义外零调用。 |
| `helpers.rs:803` | `build_transient_skill_messages` | 除定义外零调用。 |
| `helpers.rs:818` | `build_transient_skill_messages_with_audit` | 只被上一条无调用 wrapper 与 helpers 内联测试调用；生产使用 `_excluding` 版本。 |
| `multi_variant.rs:789` | `execute_single_variant` | 除定义外零调用；现行执行与 retry 路径使用 `execute_single_variant_with_config`。 |
| `llm_adapter.rs:651` | `ChatV2LLMAdapter::has_tool_calls` | 除定义外零调用。 |
| `variant_adapter.rs:391` | `VariantLLMAdapter::get_thinking_block_id` | 除定义外零调用；现行多变体路径直接从 context 读取。 |
| `variant_adapter.rs:411` | `VariantLLMAdapter::get_content_block_id` | 除定义外零调用；现行多变体路径直接从 context 读取。 |

其余本轮新增或缓存相关关键符号均有生产调用，包括
`load_session_tool_face_prefix`、`converge_session_tool_face_prefix`、
`record_skill_digest_prefix_generation_signal`、`freeze_tool_face_for_prompt_cache`、
`enforce_anthropic_cache_breakpoint_budget`、model-special-token 游标 helper，
以及 TauriAdapter snapshot 的两个 generation 解析 helper 和 freeze 等待点。

## `allow(dead_code)`

- 指定扫描面仅一处：`tool_loop.rs:3690` 的
  `#[allow(dead_code)]`，对应上表 `run_bounded_ordered`。
- 其余上表生产无调用符号没有 `allow(dead_code)`。
- `stream_filter_core.rs` 与 `history.rs` 按席位边界未纳入统计。

## Retention 删除残留

- 可执行 Rust 中
  `fn apply_openai_prompt_cache_retention`、
  `fn provider_accepts_prompt_cache_retention`、对应调用表达式，以及
  `prompt_cache_options` 的 24h JSON 写入均为零：已删除实现没有复活。
- 若按**字面量**而不是可执行结构检索，结果不是零：
  `model2_pipeline.rs:3584-3587` 的墓碑注释仍提到两个旧函数名及历史错误值
  `ttl:"24h"`。这些命中只是解释删除原因与防复活约束，不是定义、调用或请求体写入。

## R5-M2-1 注释改口

`cache_debug_log_post_adapter_fingerprint` 的 rustdoc 现明确写为：

> `scope_key` 为 `session::variant`。单变体路径里的 `variant_id` 实际通常是
> assistant 消息 ID，每个 turn 都会新建，因此跨 turn 往往没有同 key 的上一请求，
> 常落为 `baseline`；本日志不能解读为「跨 turn 稳态指纹」。

同时保留 post-adapter 对 system / tools / history / current-user 四段取指纹的事实。
