# r1 锚定：tool_loop.rs（Wave2-A 第 1 轮 #5）

- 基线：`origin/cursor/0824-cde6` @ `061b4815`；本枝 `cursor/0824-wave2-agent-cache-a875`（tip `44176988`，tool_loop 无本枝改动）。
- 对象：`src-tauri/src/chat_v2/pipeline/tool_loop.rs`（5125 行，已全量通读）。
- 相关测试：`prefix_snapshot_tests.rs`（235 行）、`parallel_exec_tests.rs`（396 行）、tool_loop 内 `#[cfg(test)] mod tests`（:3576-5125）。
- 本文只锚定现状，不改产品代码、不建议改语义。

## 0. 生产入口确认

`execute_with_tools`（tool_loop.rs:304）由 `pipeline.rs:986` 与 `pipeline.rs:1041` 两处在 `tokio::select!` 内调用（主发送路径 + 工作区继续轮路径），在树上、非死代码。多变体路径不走 `execute_with_tools`，走 `multi_variant.rs` 自己的变体环，但复用 tool_loop 的 `apply_doom_loop_guard`（multi_variant.rs:1543）与 `execute_tool_calls`（multi_variant.rs:1560）。

## 1. 冻结原语调用点表

### 1.1 原语定义（均在 tool_loop.rs）

| 函数 | 行号 | 冻的是什么 |
|---|---|---|
| `tool_schema_sort_key` | :15-21 | 排序键：`function.name`，回退顶层 `name`，缺失为 `""` |
| `sort_tool_schemas_for_prompt_cache` | :26-28 | 仅确定性字母序排序（G6），无冻结状态 |
| `freeze_tool_schema_order_for_prompt_cache` | :39-72 | **名字序**：空基线首轮字母序建立；已有基线按冻结序 stable sort，新名追加末尾并记入基线（append-only 首见序） |
| `merge_frozen_tool_schema_order_baseline` | :78-87 | 名字序基线合并（只补缺失名，绝不删除/重排），供并行变体写回与持久化合并 |
| `freeze_tool_schemas_for_prompt_cache` | :105-132 | **名字序 + 字节**：先调名字序冻结（:110），再对已发出工具**无条件回写**首见 schema 副本（:116-130，preserve_order 下键序扰动也被归一），同名变更延迟到下一稳定窗口 |

### 1.2 生产调用点

| # | 位置 | 路径 | 调的原语 | 冻名字序 or 字节 |
|---|---|---|---|---|
| 1 | tool_loop.rs:330-331 | 单变体 `execute_with_tools` 环外初始化 | `load_session_frozen_tool_schema_order`（helpers.rs:1017-1047：内存 map miss 时从 session.metadata 恢复，append-only 合并） | 载入名字序基线（会话级） |
| 2 | tool_loop.rs:337 | 单变体环外初始化 | `frozen_tool_schemas: HashMap<String, Value>` 声明 | 字节冻结容器，**窗口级**（一次 `execute_with_tools` = 一个稳定窗口），不持久化 |
| 3 | tool_loop.rs:985-989 | 单变体每轮，`custom_tools` 合并完成后 | `freeze_tool_schemas_for_prompt_cache` | **名字序 + 字节**（全仓唯一的字节级生产调用点） |
| 4 | tool_loop.rs:992-995 | 紧随 #3 | `store_session_frozen_tool_schema_order`（helpers.rs:1058-1081：内存 merge + `ChatV2Repo::merge_session_frozen_tool_schema_order` 持久化，失败仅降级打日志） | 只写回名字序；:990-991 注释明确「字节冻结保持窗口级，不写回」 |
| 5 | multi_variant.rs:961 | 多变体 `execute_single_variant`（无工具环的单发变体路径） | `sort_tool_schemas_for_prompt_cache` | 仅字母序排序，**无冻结** |
| 6 | multi_variant.rs:1274-1275 | 多变体工具环入口 | `load_session_frozen_tool_schema_order` | 载入名字序基线 |
| 7 | multi_variant.rs:1316-1323 | 多变体工具环首次注入 | `freeze_tool_schema_order_for_prompt_cache` + `store_session_frozen_tool_schema_order` | **只冻名字序** |
| 8 | multi_variant.rs:1679-1686 | 多变体环内 load_skills 渐进披露后 `refreshed_tools` 全量重建 | `freeze_tool_schema_order_for_prompt_cache` + `store_session_frozen_tool_schema_order` | **只冻名字序** |

持久化底座：`pipeline.rs:192/:240`（`frozen_tool_schema_orders: Arc<Mutex<HashMap<..>>>` 内存 map）；`repo.rs:32`（`frozen_tool_schema_order_from_metadata`）、`repo.rs:2658/:2667`（get）、`repo.rs:2686/:2699-2708`（metadata 单键 append-only merge，内部复用 tool_loop 的 merge 函数）。

grep 验证：`freeze_tool_schemas_for_prompt_cache` 与 `frozen_schemas` 在 multi_variant.rs **零命中**——字节级冻结不覆盖多变体路径。

## 2. hooks 调用点表（tool_loop.rs 内四切点）

| 切点 | 行号 | 触发时机 | 失败是否传播 |
|---|---|---|---|
| `before_turn` | :345-347 | 工具环每轮迭代开头，doom-loop 终止检查（:354）、递归上限检查（:418/:431）与本轮 LLM 调用之前 | **传播**：`hook.before_turn(...).await?`，`Err` 直接中断整个回合，错误上抛给 `execute()` |
| `before_compaction` | :467-469 | `ctx.needs_compaction` 命中后、`run_compaction`（:470）真正执行前 | **不可失败**：无 `Result` 返回值，只能观察/打日志 |
| `before_tool` | :3190-3195 | `execute_single_tool` 内，`ToolHookContext`（:3173-3188）与 `ToolAdmission::new`（:3189）之后、`ExecutionContext` 构建（:3200）之前 | **不走 Err**：`ToolGateOutcome::Block(result)` 时 `return Ok(*result)`（:3193）——拦截结果作为失败 tool result 回喂模型，不中断回合 |
| `after_tool` | :3271-3274 | `executor_registry.execute` 返回 `Ok` 后、结果回喂前（`&mut result` 可注记） | **不可失败**：无返回值；注意 executor `Err` 分支（:3277-3307）不经过 `after_tool` |

多变体路径经 `multi_variant.rs:1560 → execute_tool_calls → execute_single_tool` 复用 `before_tool` / `after_tool`；`before_turn` / `before_compaction` 在 multi_variant.rs **无调用点**（grep 零命中），仅单变体环触发。

四切点失败语义的权威文档在 hooks.rs:100-111（trait 定义处注释），与 tool_loop 实际调用一致。

## 3. TOCTOU 三段检查（只记录，不建议改）

三段式的语义：审批/计划等待可长时间挂起，期间紧急停止、取消、会话模式/审批策略变化必须在副作用开始前生效——check 与 use 之间的窗口逐段闭合。

| 段 | 位置 | 语义 |
|---|---|---|
| 第一段（准入入口） | hooks.rs:279-329（`ApprovalGateHook::before_tool` 最前，「Kill Switch first」） | 任何授权/审批评估之前先查 kill switch，被拦截时发 start+error 事件并 Block（`killSwitchBlocked: true`） |
| 第二段（审批等待后复核） | hooks.rs:824-859（本地终端审批绑定重解析复核，runtime root binding / scope key 失配 fail-closed）→ :861-873（kill switch 复查 + cancellation 复查）→ :874-913（现读会话权限，读取失败 fail-closed；plan binding 覆盖二次审批的复评；审批要求变更即拦截）→ :914-940+（`evaluate_authority_gate` 复评 + `consume_session_plan_binding` 原子消费，消费失败/已消费即 Block） | 人工审批/计划等待返回后，一切可撤销授权全部现读复核；计划批准单次原子消费（并发下恰好一次，见测试 :4489） |
| 第三段（执行前终检） | tool_loop.rs:3249-3264（「Final admission point」：hook 链通过、`ExecutionContext` 构建完成之后，`executor_registry.execute`（:3267）之前） | :3251-3255 `kill_switch.ensure_allowed()` 失败 → `preflight_blocked_result`；:3256-3264 取消令牌已取消 → 同样阻断。堵住「计划消费/上下文构建期间触发紧急停止」的最后窗口 |

## 4. 十五段准入的编排位置

**tool_loop 内无十五段准入编排。** `execute_single_tool` 只做三件事：构建 `ToolHookContext` + `ToolAdmission`（:3173-3189）、逐 hook 调 `before_tool`（:3190-3195）、以及自留的第三段 TOCTOU 终检（:3249-3264）。完整准入序列（Kill Switch → 运行时 allowlist → trusted automation → 功能开关 → 灾难命令守卫 → 用户命令规则 → 审批作用域绑定 → AuthorityGate（Ask/Plan/Craft）→ ApprovalManager 人工审批 → 审批后重绑定复核 → 计划批准原子消费等）全部编排在 **hooks.rs `ApprovalGateHook::before_tool`（:254 起）**，见 hooks.rs 文件头 :1-20 的模块文档。默认链顺序（`ApprovalGateHook` 首位 + `TaskAuditHook`）由 `default_pipeline_hooks` 与测试 `default_hooks_keep_approval_gate_first` 锁定（hooks.rs，本轮归 #6 独占改动区）。

## 5. 测试清单（测试名 + 断言意图）

### 5.1 tool_loop.rs `#[cfg(test)] mod tests`（:3576-5125）

冻结/排序类：

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `tool_schema_sort_key_reads_function_name_and_falls_back_to_top_level` | :3585 | 排序键读 `function.name`，回退顶层 `name`，两者皆无为 `""` |
| `tool_schema_sort_orders_openai_function_schemas_deterministically` | :3600 | G6：OpenAI function 格式确定性字母序 + 幂等 |
| `frozen_tool_order_appends_new_tools_without_touching_sent_prefix` | :3619 | 环内新工具只追加末尾，已发出前缀逐项字节不变 |
| `frozen_tool_order_survives_full_rebuild_and_stays_idempotent` | :3656 | 全量重建（源顺序打乱）按基线还原已发出序，同轮多个新工具按名字排序一并追加，幂等 |
| `frozen_tool_order_persists_across_turns_via_session_baseline` | :3697 | 跨轮会话基线：第二轮字节前缀不变；第三轮工具消失不删基线条目 |
| `session_baseline_merge_is_append_only_across_parallel_variants` | :3764 | 并行变体写回共享基线只追加、绝不删除/重排 |
| `frozen_tool_schema_bytes_survive_append_and_same_name_change` | :3788 | 字节级：同名 schema 中途变更本窗口继续发冻结字节；追加工具自首见轮起字节冻结 |
| `same_name_schema_change_applies_at_next_stable_window` | :3873 | 窗口边界：窗口 1 内变更延迟；窗口 2（字节映射重建）采纳新字节并随即冻结，不回退 |
| `frozen_tool_schema_bytes_normalize_key_order_permutation` | :3907 | preserve_order 下键序扰动（`==` 相等但字节不同）必须被无条件回写归一 |
| `in_loop_load_skills_keeps_memory_prefix_byte_stable_within_turn` | :3938 | P1-8：环内 load_skills 不改当前 user 之前任何字节；每轮消息序列是上一轮的严格字节前缀延伸 |

reasoning item / usage 类：

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `tool_round_reasoning_items_pair_by_tool_call_id` | :4058 | Responses reasoning item 按 tool_call_id 键控，禁止全绑第一个 tool id |
| `tool_round_unpaired_fallback_never_overwrites_paired_item` | :4076 | 未配对条目兜底挂 fallback，`or_insert` 不覆盖已配对；无 fallback 安全丢弃 |
| `final_round_reasoning_unpaired_items_use_sentinel_key_last_wins` | :4110 | 纯文本终轮未配对条目挂哨兵键，多条后到覆盖 |
| `failed_round_retains_and_accumulates_reported_partial_usage` | :4132 | 失败轮已上报 usage（含 cached/cache_write 聚合）保留并累加 |
| `failed_round_without_reported_usage_does_not_change_totals` | :4150 | 无上报 usage 时累计值不变 |

工具排序类（`order_tool_calls_for_execution`）：

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `chatanki_card_mutations_keep_explicit_read_write_read_order` | :4161 | 同优先级 stable sort 保留读-写-读原序 |
| `chatanki_export_still_runs_after_card_mutations` | :4174 | export/sync 排在卡片增删之后 |
| `chatanki_enqueue_runs_after_card_work_and_before_external_outputs` | :4187 | enqueue 在卡片操作后、export/sync 前 |
| `chatanki_retemplate_keeps_get_write_get_before_enqueue_and_export` | :4207 | retemplate 归入写优先级且不破坏读写读 |

权限/断电集成类（真实 SQLite + CountingWriteExecutor，穿 `execute_single_tool` 全链）：

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `ask_mode_blocks_medium_write_without_calling_executor` | :4346 | Ask 档拦写：executor 0 调用 + `AUTHORITY_BLOCKED` 结构化拒绝 + `suggestedMode: plan` |
| `plan_mode_suspends_then_allows_once_then_reblocks_after_expiry` | :4411 | Plan 状态机：无计划挂起 → 批准放行 → 过期重挂 |
| `plan_binding_is_consumed_exactly_once_under_concurrency` | :4489 | 双线程并发消费 plan binding 恰好一次（TOCTOU 第二段原子消费） |
| `approved_plan_binding_reaches_executor_without_secondary_approval` | :4668 | 批准的 Plan 调用直达 executor 且 binding 执行前被消费 |
| `missing_approval_manager_blocks_required_tool_before_executor` | :4709 | 审批服务缺失 fail-closed（executor 0 调用） |
| `c4_ask_mode_write_tool_zero_executor_structured_reject` | :4769 | C4-1：Ask + 写工具，DB 档位不变 |
| `c4_craft_kill_switch_blocks_write_despite_craft_mode` | :4816 | C4-2：断电优先于 Craft + remembered allow |
| `c4_plan_approved_then_kill_switch_still_blocks_writes` | :4891 | C4-3：Plan 批准后断电仍拦，plan 状态不被清 |
| `c4_headless_ask_persisted_blocks_write_on_tool_loop` | :4967 | C4-4：headless 白名单放行也挡不住持久化的 Ask |
| `c4_kill_switch_reject_all_pending_then_resume_allows_write` | :5056 | C4-5：断电 drain 待审批 → resume 后恰好执行一次 |

### 5.2 prefix_snapshot_tests.rs（由 pipeline.rs:90 声明）

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `system_prefix_bytes_identical_across_rounds_while_volatile_inputs_change` | :87 | todos/canvas/检索/画像逐轮变化时 stable_system 字节逐轮相等，变化全落 turn-volatile |
| `todos_and_canvas_never_leak_into_stable_system` | :115 | 动态标签与动态文本不得出现在 stable system |
| `emitted_tools_serialization_is_strict_byte_prefix_of_later_rounds` | :146 | 跨轮 + 基线 JSON 持久化往返（模拟进程重启）后，已发出 tools 字节是后续轮次严格前缀 |
| `combined_request_prefix_only_grows_at_the_tail_across_rounds` | :199 | system+tools 组合请求前缀跨轮只允许尾部追加 |

注意：该文件只覆盖**名字序**冻结（import 只有 `freeze_tool_schema_order_for_prompt_cache` + `merge_frozen_tool_schema_order_baseline`，见 :21-24），字节级 `freeze_tool_schemas_for_prompt_cache` 的快照测试都在 tool_loop 内联模块。

### 5.3 parallel_exec_tests.rs（由 pipeline.rs:87 声明）

| 测试 | 行号 | 断言意图 |
|---|---|---|
| `plan_segments_groups_consecutive_parallel_calls` | :29 | R/S 混排切段正确 |
| `plan_segments_all_serial_is_single_segment` / `all_parallel` / `empty_input` / `single_call` | :46/:52/:58/:63 | 边界形状 |
| `plan_segments_cover_all_indices_in_order` | :70 | 分段首尾相接覆盖全部下标（保序回填前提） |
| `bounded_ordered_preserves_input_order` | :88 | 后完成不插队，按输入顺序回填 |
| `bounded_ordered_runs_concurrently` | :102 | 并发度 4 下 4×100ms ≈ 100ms（虚拟时钟） |
| `bounded_ordered_respects_concurrency_limit` | :120 | 并发度 2 下 6 任务 ≥300ms |
| `segmented_execution_backfills_in_original_order` | :139 | 混排端到端结果与原始调用顺序一致 |
| `transient_errors_are_retryable` / `permanent_errors_are_not_retryable` / `cancelled_errors_are_never_retryable` | :170/:191/:211 | 瞬时错误启发式正负例；取消/闸门/partial 绝不重试 |
| `retry_backoff_schedule_matches_spec` | :227 | 退避 [500, 2000]，并发度落 4-6 区间 |
| `annotate_without_retries_is_untouched` / `annotate_success_after_retries_marks_output` / `annotate_failure_after_retries_appends_error_note` / `annotate_non_object_output_only_touches_error` | :254/:262/:273/:291 | `_auto_retry_attempts` 标注语义 |
| `retry_attempts_are_pinned_to_one_logical_block` | :299 | 重试各次尝试钉在同一逻辑块 |
| `stream_hook_keys_are_unique_across_same_message_retry` | :312 | run-scoped 流事件键跨重试唯一且保留 `_var_` 会话路由 |
| `read_only_executors_declare_read_only_class` | :333 | 各 executor 并发等级声明（load_skills 保持 Serial） |

### 5.4 冻结基线持久化的外围测试（供交叉引用）

repo.rs:4313（重启存活）、:4341（metadata merge append-only）、:4382（不碰其他 metadata 键）、:4447（缺键回退空基线）；pipeline.rs:1153（内存清空后从库恢复）。

## 6. P3 现状（精确行号）

**P3-a：schema 字节只冻单个稳定窗口（一次 `execute_with_tools`），不跨窗口/不跨进程。**

- tool_loop.rs:337 —— `frozen_tool_schemas: HashMap<String, Value>` 在 `execute_with_tools` 函数体内声明，随 future 生命周期销毁；:332-336 注释明确「窗口级持有（不随名字序基线持久化）：跨窗口允许采纳新字节」。
- tool_loop.rs:985-989 —— 全仓唯一字节级生产调用点。
- tool_loop.rs:990-991 —— 「字节冻结（frozen_tool_schemas）保持窗口级，不写回」；:992-995 只把名字序写回会话级状态。
- 结论：同会话下一个用户回合（新 `execute_with_tools`）字节映射重建，同名 schema 变更此时生效——名字序跨轮冻结、字节只冻单轮，这是有意设计（测试 :3873 `same_name_schema_change_applies_at_next_stable_window` 锁定该边界），但意味着跨回合的 tools 前缀字节稳定只由「名字序 + schema 内容恰好未变」保证，无字节级兜底。

**P3-b：多变体路径只冻名字序，无字节冻结。**

- multi_variant.rs:1316-1319 与 :1679-1682 —— 只调 `freeze_tool_schema_order_for_prompt_cache`（名字序），配套 :1320-1323 / :1683-1686 写回会话基线。
- multi_variant.rs:961 —— `execute_single_variant` 路径连名字序冻结都没有，只做一次性 `sort_tool_schemas_for_prompt_cache`（该路径不载入/写回会话基线）。
- grep 验证：`freeze_tool_schemas_for_prompt_cache` / `frozen_schemas` 在 multi_variant.rs 零命中。
- 后果：多变体工具环内 MCP 刷新 / load_skills 披露不同版本的同名 schema 时，已发出工具的序列化字节可在轮间漂移（名字序不变但字节变），变体请求的 tools 前缀缓存可能失效；单变体已由 P0 字节级加强覆盖（:105-132）。

## 7. prefix freeze / cache_write_tokens 生产路径是否在树上

**均在树上：**

- prefix freeze（tools 冻结）：`execute_with_tools` 被 pipeline.rs:986 / :1041 生产调用（见 §0）；冻结调用点 :985-995 在每轮 `custom_tools` 存在时必然执行；会话基线持久化链 helpers.rs:1017-1081 → repo.rs:2658-2708（session.metadata 单键 merge）完整可达。P1-8 技能注入冻结（`frozen_turn_skill_injection` :324、首轮构建 :581-611、逐轮复用 :612-620、环内锚定批次回放 :664-672 与 :1796-1846）同在主路径。
- `cache_write_tokens`：解析在 llm_adapter.rs:129-152（Anthropic `cache_creation_input_tokens` / Responses `input_tokens_details.cache_write_tokens` / 网关顶层字段聚合）；成功轮入账 tool_loop.rs:1378-1399（:1385-1387 传入 `record_llm_usage_cache_ext`）；失败轮部分用量入账 tool_loop.rs:1440-1475（:1457-1461，无测量落 NULL）；类型字段 chat_v2/types.rs:210 与 llm_usage/types.rs:179；入口 llm_usage/mod.rs:184。失败轮保留语义由测试 :4132/:4150 锁定。
- `run_bounded_ordered`（tool_loop.rs:3519）标了 `#[allow(dead_code)]`：生产并行段直接用相同的 `futures::stream::iter(..).buffered(..)` 组合子（:2688-2691），该函数仅供测试锁语义——不算生产死路径，但也不是生产调用点，引用时注意区分。

## 8. 其他锚点（供后续轮次引用，非本任务验收项）

- 会话级名字序基线载入/写回：单变体 :330-331 / :992-995；多变体 :1274-1275 / :1320-1323 / :1683-1686。
- doom loop：观察/拦截 `apply_doom_loop_guard` :2397-2462（多变体共用），终止收尾 :354-383，合成结果保序归并 `merge_round_results_in_call_order` :3548-3574。
- 环内 compaction：:465-532（重载失败回滚内存历史）；检查点 A :1361-1369，检查点 B :1970-1988。
- 并行执行：分段 :2608-2618、并行段 :2629-2694（并发度 4，:3403）、串行段 :2696-2824（截断标记处理 :2701-2782）。
- 心跳白名单/递归上限：:390-457（ABSOLUTE_MAX 150 / heartbeat 上限 50）。
- StreamHooksGuard（RAII 注销）：:196-284，run-scoped 事件键 :207-226。
