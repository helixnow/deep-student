# r5-provider-p2：Step 22 四项遗留收口（P2 死分支活化 + 四槽预算守卫）

- 执行人：Wave2-A 第 5 轮子代理 #2（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 独占文件：`src-tauri/src/providers/mod.rs`
- 上游台账：`docs/dev/wave2-A/r1-provider-step22.md`
- 铁律遵守：未跑 cargo/npm/任何测试，所有测试只写源码；未 commit。

## 〇、结论速览

| # | 项 | 本轮动作 | 状态 |
| --- | --- | --- | --- |
| P0 | breakpoint 三类快照 | 三类主快照已存在（r1 已核），按 r1 建议补 2 条端点变体钉子测试 | 测试源码补齐 |
| P1 | include_usage 终止状态机 | 确认 choice 完成≠流完成（代码未动），补 1 条完整事件序列测试 | 测试源码补齐 |
| P1 | stream_options 门控 | 确认只对官方 host 注入（代码未动），补 1 条官方变体/伪装钉死测试 | 测试源码补齐 |
| P2 | 工具 marker 死分支 + 四槽预算 | **代码修复已落地**：透传 `tools[].cache_control` 活化 `has_marker`；新增四槽预算守卫 | **已修，死分支已活** |

## 一、P2 死分支是否已活：**已活**

### 修复 1：`convert_tool_definition` 透传 `cache_control`

- 位置：`providers/mod.rs:3334`（函数体收口处，原 `:3276` 恒 `cache_control: None`）。
- 改动：`let cache_control = value.get("cache_control").cloned();` —— 调用方在
  OpenAI 形状 `tools[]` 条目上打的块级缓存标记原样透传，不再静默丢弃。
- 效果：`convert_openai_to_anthropic` 里 `:2402` 的
  `has_marker = converted.iter().any(|tool| tool.cache_control.is_some())`
  从恒 false 变为可达——调用方已打 marker 时 `:2403-2407` 的
  「不追加尾部保险断点」分支真正生效（选择的是 r1 建议二选一中的
  「透传活化」路线，而非删检查）。
- 注释同步：`:2398-2401` 的 tools 尾断点注释注明「调用方已透传块级 marker
  时视为断点位置由上游指定，不再追加」。

### 修复 2：四槽预算守卫（automatic 占 1）

- 常量：`ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4`（`providers/mod.rs:2923`）。
- 守卫函数：`enforce_anthropic_cache_breakpoint_budget`
  （`providers/mod.rs:2930-2977`，紧跟 `AnthropicTool` 定义之后）。
- 接线位置：`convert_openai_to_anthropic` 收口处 `providers/mod.rs:2412-2414`
  —— 在 tools 转换（含尾保险断点）与 system 尾断点都打完之后、
  `system_blocks` 封装成 `Value::Array` 之前调用
  `enforce_anthropic_cache_breakpoint_budget(tools.as_mut(), &mut system_blocks)`。
  为此把原先位于 tools 之前的 `let system = ...` 收口下移到守卫之后
  （`:2416-2420`），纯顺序调整，无语义变化。
- 预算语义：
  - 顶层 automatic `cache_control`（`:2496-2498` 恒注入）占 1 槽，
    块级断点预算 = 4 − 1 = 3；
  - 计数面 = tools 块级 marker + system 块级 marker。消息块转换
    （`convert_user_message` / `convert_assistant_message` /
    `convert_tool_result_message`）不承接 `cache_control`，无第三来源，
    计数面即全集；
  - 超载剥除序：按 prompt 序（Anthropic 缓存前缀顺序 tools → system →
    messages）从最靠前的 marker 开始剥——tools 先于 system、system 内
    靠前块先剥；越靠后的断点覆盖的稳定前缀越长、命中价值越高，尾部
    marker 最后保留。与 r1 §四建议 2 的「从最靠前的低价值 marker 开始
    降级剥除」一致。
- 不剥 automatic：顶层槽是兜底缓存面，守卫只裁块级 marker。

### 边界测试（3 条，只写不跑）

| 测试 | 位置 | 覆盖 |
| --- | --- | --- |
| `anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint` | `:5766` | 调用方 `tools[0].cache_control` 透传保留；`has_marker` 命中 → 尾块不再追加（死分支活化的直接证据） |
| `anthropic_cache_breakpoint_budget_keeps_full_four_slots` | `:5796` | 四槽满载（automatic 1 + tools 尾 1 + system 块级 2）恰好用满，不触发剥除 |
| `anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow` | `:5844` | 块级 5 marker（tools 2 + system 3）超载 2 → 剥除最靠前的 2 个 tools marker，system 3 个与 automatic 全保留 |

### 存量测试兼容性推演（未执行）

- `anthropic_adds_tools_and_system_tail_cache_breakpoints`（`:5684`）：
  块级 2 个 ≤ 3，守卫不触发，断言不受影响；
- `anthropic_preserves_caller_block_level_system_cache_control`（`:5731`）：
  块级 1 个，同上；
- `model2_pipeline.rs:3665` 生产打点（1 system marker + tools 尾 1）= 块级 2，
  远低于预算，守卫在现实流量下为纯守护、无行为变化。

## 二、P1 include_usage：choice 完成≠流完成 —— 确认 + 补事件序列测试

- 复核确认（代码未动）：`finish_reason` 仅置位 `saw_finish_reason`
  （`:303-310` 一带），Done 只来自 `[DONE]`、流内 error 注入、EOF
  `finish_stream()` 三源；`openai_choices_finished` 要求 choices 非空且
  全部完成。choice 完成与流完成的分离成立。
- 新增测试：`openai_adapter_choice_completion_keeps_event_sequence_until_done_marker`
  （`providers/mod.rs:3973`）。序列：finish_reason 块（含内容）→ 后续内容块
  （宽松网关补发）→ usage-only 块（`choices:[]` + `prompt_tokens_details.
  cached_tokens`，正是 include_usage 请求来的缓存命中数据）→ 全程无 Done
  断言 → `[DONE]`。终态断言：4 事件严格保序
  （content/content/Usage{total_tokens:18, cached_tokens:8}/Done），且
  `[DONE]` 消费完成状态后 `finish_stream()` 为空（EOF 不重复发 Done）。
  与既有 `openai_adapter_emits_usage_before_done_for_official_chunk_sequence`
  （`:3877`）互补：那条测官方紧凑序列，这条测 finish_reason 之后仍有
  内容块的乱序面 + [DONE] 与 EOF 收口的互斥。

## 三、P1 stream_options：钉死官方才注入 —— 确认 + 补钉死测试

- 复核确认（代码未动）：注入条件 `is_stream &&
  is_official_openai_api_endpoint(base_url) && !contains_key("stream_options")`
  （`:161-172`），host 经 `url::Url` 解析精确等于 `api.openai.com`（`:130-135`）。
- 新增测试：`openai_adapter_stream_options_gate_pins_official_host_variants`
  （`providers/mod.rs:6460`）。正例 4：裸域 / 带尾斜杠 / 大写 host /
  带 query+fragment 的官方变体均注入；负例 5：子域 `mirror.api.openai.com`、
  连字符伪装 `api-openai.com`、后缀伪装 `api.openai.com.evil.example`、
  无 scheme（URL 解析失败 → fail-safe）、空串均不注入。
- r1 §三「能力白名单扩容（api.deepseek.com / openrouter.ai）」是行为变更，
  超出本卡「钉死现状」范围，未做，留给后续调研卡合流。

## 四、P0：三类快照 —— 已存在，补 2 条变体钉子

- 三类主快照 `openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated`
  （`:5193`）已覆盖：官方端点 + GPT-5.6（整包 wire body 含
  `prompt_cache_breakpoint: {"mode":"explicit"}`）/ 第三方网关同名模型
  （回落顶层 instructions、无断点字段）/ 官方端点 + 偶含 gpt-6 的伪名
  `deployment-not-gpt-6-preview`（不注入）。r1 已判「已修」，本轮复核维持。
- 按 r1 §一建议新增
  `openai_responses_prompt_cache_breakpoint_gate_covers_endpoint_variants`
  （`providers/mod.rs:5277`）：官方端点带 query/fragment 变体
  （`https://api.openai.com/v1/?token=x#frag`）仍注入断点；遗留无端点包装
  `convert_to_responses_format`（空 base_url）恒不注入且 system 回落顶层
  instructions——防止未来有人把生产调用误接回无端点包装。

## 五、改动清单

代码（2 处，均在 `src-tauri/src/providers/mod.rs`）：

1. `convert_tool_definition` 透传 `tools[].cache_control`（`:3330-3340`）；
2. 新增 `ANTHROPIC_CACHE_BREAKPOINT_BUDGET` 常量 +
   `enforce_anthropic_cache_breakpoint_budget` 守卫（`:2919-2977`），
   在 `convert_openai_to_anthropic` 收口接线（`:2412-2420`），
   tools 尾断点注释同步（`:2398-2400`）。

测试源码（6 条新增，0 条改动，全部未执行）：

| 测试 | 行号 | 归属 |
| --- | --- | --- |
| `openai_adapter_choice_completion_keeps_event_sequence_until_done_marker` | `:3973` | P1 include_usage |
| `openai_responses_prompt_cache_breakpoint_gate_covers_endpoint_variants` | `:5277` | P0 变体钉子 |
| `anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint` | `:5766` | P2 死分支 |
| `anthropic_cache_breakpoint_budget_keeps_full_four_slots` | `:5796` | P2 预算满载 |
| `anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow` | `:5844` | P2 预算超载 |
| `openai_adapter_stream_options_gate_pins_official_host_variants` | `:6460` | P1 stream_options |

## 六、遗留与移交

- 守卫剥除时不区分「调用方显式 marker」与「自动保险断点」的价值权重，
  一律按 prompt 序剥前保尾；若后续要实现「自动断点先让位于调用方断点」
  的优先级，需给 `AnthropicTool.cache_control` 增加来源标记，本轮不做。
- 消息尾断点（对话稳定前缀第 3 槽 + 增量第 4 槽的递进式缓存）仍缺位，
  守卫已为其预留计数面（消息块一旦承接 marker，纳入同一预算即可），
  归 #1 调研卡。
- pipeline 层「网关省略 [DONE] + EOF 收口为成功」集成测试在
  `model2_pipeline.rs`，超出本卡独占文件范围，未动（r1 §二建议原样移交）。
- 所有新增测试与既有 13 条相关测试一样，只有源码、未经 cargo test 执行。
