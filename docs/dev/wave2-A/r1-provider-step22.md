# r1-provider-step22：Step 22（35706d09 → 55846040）四项评审独立复核台账

- 复核人：Wave2-A 第 1 轮子代理 #9「锚定员-provider」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `44176988`（含 Step 23 tip `061b4815`）
- 复核对象：`git show 55846040`（cherry-pick 自 `35706d09`，commit message
  "fix provider capability gating and stream completion"，7 文件 +302/-98，
  其中 `src-tauri/src/providers/mod.rs` 308 行改动）
- 方法：**独立阅读当前 tip 的 `providers/mod.rs`（6374 行）与 55846040 diff 对照**，
  不假设旧评审文档结论仍正确。只读，未跑任何测试/编译（按本轮铁律）。

## 〇、四项裁决速览

| # | 评审项 | 裁决 | 现有测试 |
| --- | --- | --- | --- |
| P0 | `prompt_cache_breakpoint` 对象形状 + 端点门控 | **已修** | 2 个 |
| P1 | `include_usage` 与 `finish_reason` 提前 Done 终止状态机 | **已修** | 4 个（+harness 1 个，+pipeline 终止门 3 个相邻） |
| P1 | `stream_options` 无条件下发的兼容网关 400 面 | **已修** | 1 个 |
| P2 | Anthropic 四断点槽位预算 + 工具 marker 死分支 | **未修** | 死分支/预算本身零测试（相邻 P2-11 测试 2 个） |

---

## 一、P0：`prompt_cache_breakpoint` 官方对象形状 + 端点门控 —— **已修**

### 证据（当前 tip 行号）

1. **wire 形状已是官方对象形状**：`providers/mod.rs:1563`
   `"prompt_cache_breakpoint": { "mode": "explicit" }`（55846040 之前是
   `prompt_cache_breakpoint: true` 布尔，diff 可证）。
2. **端点门控已加**：`providers/mod.rs:758-760`
   `endpoint_supports_prompt_cache_breakpoint(base_url)` →
   `is_official_openai_api_endpoint`（`:130-135`，`url::Url` 解析后
   host 精确等于 `api.openai.com`，抗 `api.openai.com.evil.example` 后缀伪装）。
   注入条件三与：`:1552-1554` `!instructions.is_empty() && 模型支持 && 端点支持`。
3. **模型名解析收紧**（55846040 顺带）：`providers/mod.rs:721-756`
   只解析 `rsplit('/')` 后的完整型号段并 `strip_prefix("gpt-")`，
   `not-gpt-6` / `deployment-not-gpt-6-preview` 等子串误报被排除；
   major>5 与 5.6+ 的后缀白名单（空 / `-` / `_` / `.数字`）。
4. **base_url 流向核实**：生产路径 `build_request` 在 `:1833` 调
   `convert_to_responses_format_for_endpoint(model, body, base_url)`，真实端点
   进入门控。遗留包装 `convert_to_responses_format`（`:1449-1451`，传空
   base_url → 门控恒 false）**只剩测试模块调用**（全部命中行在
   `mod tests` 内，:4153 起），无生产调用点——已 grep 全仓核实。

### 现有测试（2 个）

- `openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated`
  （`providers/mod.rs:5091`）：官方端点+gpt-5.6 → developer 首块带
  `{"mode":"explicit"}` 的**整包 wire body** 快照断言；第三方网关同模型 →
  回落顶层 `instructions`、无断点字段；`api.openai.com` + 伪 gpt 名 → 不注入。
- `model_supports_prompt_cache_breakpoint_parses_gpt_versions`
  （`providers/mod.rs:5172`）：正例 gpt-5.6/5.6-sol/5.7/5.10/6/openai/gpt-6.1，
  负例 gpt-5/5.5/4o/`deployment-not-gpt-6-preview`/`not-gpt-5.6`/deepseek/qwen。

### 第 5 轮建议

- 形状与门控已闭环。建议**补一条负向快照**：`base_url` 为
  `https://api.openai.com/v1/?token=x#frag` 等带 query/fragment 的官方端点变体
  仍应命中门控（`is_official_openai_api_endpoint` 走 host 解析理应通过，但
  无测试固化）；以及 `convert_to_responses_format` 空端点包装的「永不注入」
  语义补一行断言，防止未来有人把生产调用误接回无端点包装。

---

## 二、P1：`include_usage` 与 `finish_reason` 提前 Done 终止状态机 —— **已修**

### 评审原诉求

旧代码在 `finish_reason` 出现的同一 SSE 块直接推 `StreamEvent::Done`，导致
（a）官方序列里 `[DONE]` 前的 usage-only 块（`choices:[]` + usage，正是
`include_usage` 请求来的缓存命中数据）永远读不到；（b）省略 `[DONE]` 的
兼容网关又依赖这个提前 Done 才能收口——两个需求打架。

### 证据（当前 tip 行号）

1. **适配器改为有状态**：`providers/mod.rs:79-98` `OpenAIAdapter` 增
   `saw_finish_reason: AtomicBool`，`Default`/`new()`。
2. **finish_reason 不再当场发 Done**：`:303-310` 仅
   `saw_finish_reason.store(true)`；`openai_choices_finished`（`:329+`）要求
   choices 非空且**全部**带非空 finish_reason（部分完成不算）。
3. **Done 的三个合法来源**：`[DONE]` 标记（`:199-204`，同时清 flag）、流内
   `{"error":...}` 注入（`:217-220`）、传输 EOF 时 `finish_stream()`
   （`:317-326`，`swap(false)` 一次性消费，防重复 Done）。
4. **trait 缺省实现**：`:71-76` `finish_stream()` 默认空，其他适配器不受影响。
5. **EOF 接线已核实**：`llm_manager/model2_pipeline.rs:5011`
   `upstream_ended` 时 `parsed_blocks.push((None, adapter.finish_stream()))`，
   且放在**所有缓冲块解析之后**（尾随 usage 块先入队）。严格终止门
   `require_terminal_success = adapter.requires_explicit_stream_completion()`
   （`model2_pipeline.rs:4522`，OpenAIAdapter 返回 true，`providers/mod.rs:138-140`）
   与 `:5427-5428` 的失败判定由 finish_stream 的 Done 满足——省略 `[DONE]`
   的网关经 EOF 收口，不再误判截断。
6. **其他 parse_stream 消费方核实**（`finish_stream` 全仓仅
   `model2_pipeline.rs:5011` 一个生产调用点）：`llm_manager/mod.rs:7801`、
   `streaming_anki_service.rs:1245`、`qbank_grading/pipeline.rs:680`、
   `essay_grading/pipeline.rs:1324`、`translation/pipeline.rs:1160`、
   `vlm_grounding_service.rs:1035` 均为宽松循环——Done 只用于提前 break，
   EOF 本身就算完成（如 `llm_manager/mod.rs:7797-7830` 之后无条件 flush），
   不接 finish_stream 无正确性损失。**不构成半修**。

### 现有测试（4 个 mod.rs + 1 个 harness；另 3 个 pipeline 终止门相邻测试）

- `openai_adapter_emits_usage_before_done_for_official_chunk_sequence`
  （`providers/mod.rs:3814`）：finish_reason 块不出 Done；后续 usage-only 块 +
  `[DONE]` 后事件序恰为 content/reasoning/tool/usage/Done。
- `openai_adapter_bare_ndjson_finish_reason_completes_at_eof`（`:3843`）：
  裸 NDJSON finish_reason 后 parse 无 Done，`finish_stream()` 首次给 Done、
  二次为空（一次性消费断言）。
- `openai_adapter_finish_reason_ignores_empty_and_partial_multi_choice_completion`
  （`:3864`）：空 choices / 部分 choice 完成不置位；全完成时 parse 无 Done、
  finish_stream 给 Done。
- `stream_completion_requirement_matches_adapter_protocols`（`:3740`）：
  Chat/Responses 需显式终止、Anthropic 不需。
- `openai_compatible_emits_usage_and_done`
  （`llm_manager/adapters/streaming_harness.rs:654`）：官方 fixture 全程驱动
  必须同时出 Usage 与 Done。
- 相邻：`codex_stream_requires_an_explicit_terminal_success`（pipeline:1344）、
  `openai_responses_api_key_stream_requires_an_explicit_terminal_success`
  （:1355）、`provider_incomplete_reason_takes_precedence_over_terminal_success`
  （:1365）覆盖严格终止门本身。

### 第 5 轮建议

- 状态机主干已闭环。残余面：**pipeline 层无「网关省略 [DONE] + EOF 经
  finish_stream 收口为成功」的集成测试**（现有三条 pipeline 测试只测
  终止门失败面）。建议补一条 model2_pipeline 级状态机测试：
  finish_reason→EOF（无 [DONE]）→ `terminal_success == true`。
- `saw_finish_reason` 依赖「一 adapter 实例一流」约定（`build_request` 开头
  `:153-154` 重置 flag 提供了跨请求复用兜底，但并发共享同一实例仍会串味）；
  建议在 trait 文档注明单流所有权约定。

---

## 三、P1：`stream_options` 无条件下发的兼容网关 400 面 —— **已修**

### 证据（当前 tip 行号）

- `providers/mod.rs:161-172`：注入 `stream_options.include_usage=true` 的条件
  由旧「is_stream && 未显式设置」收紧为
  `is_stream && is_official_openai_api_endpoint(base_url) && !contains_key("stream_options")`。
  未知兼容网关默认不注入（`:158-159` 注释明确 400 动机）；调用方显式设置时
  原值透传（含 `include_usage:false`）。
- 门控函数复用 P0 同一个 `is_official_openai_api_endpoint`（`:130-135`），
  host 精确匹配、抗后缀伪装。

### 现有测试（1 个）

- `openai_adapter_gates_stream_options_include_usage_by_endpoint`
  （`providers/mod.rs:6118`）：官方端点注入 true；
  `gateway.example` 与 `api.openai.com.evil.example` 不注入；非流式不加；
  显式 `include_usage:false` 尊重原值（`:6155-6169`）。

### 第 5 轮建议

- 修复方向是 fail-safe（宁可官方镜像/Azure 看不到流内 usage，也不 400）。
  代价：**非官方但确支持 include_usage 的端点（Azure OpenAI、DeepSeek
  官方 `api.deepseek.com`、OpenRouter 等）流内缓存命中指标从此不可见**，
  会削弱 #3 调研的 usage 遥测面。建议第 5 轮把单 host 判断升级为
  **能力白名单**（与 `preserves_provider_reasoning_extensions` `:706-719`
  同风格的 host 集合），至少纳入 api.deepseek.com / openrouter.ai，并为
  白名单每 host 补一行注入断言。

---

## 四、P2：Anthropic 四断点槽位预算 + 工具 marker 死分支 —— **未修**

### 证据（当前 tip 行号）

1. **55846040 完全没碰这一带**：其 diff 在 providers/mod.rs 内只涉及
   OpenAI Chat/Responses 两个适配器与测试区；`convert_openai_to_anthropic`
   （`:2211-2493`）、`AnthropicRequest`（`:2790-2830`）、
   `convert_tool_definition`（`:3243-3278`）零改动。提交里的
   `llm_manager/adapters/anthropic.rs` 51 行是 Mythos 5 代际识别，与本项无关。
2. **工具 marker 死分支仍在**：`:2405` 
   `let has_marker = converted.iter().any(|tool| tool.cache_control.is_some());`
   —— 而 `converted` 全部来自 `convert_tool_definition`，后者**恒定**
   `cache_control: None`（`:3276`），调用方在 OpenAI 形状 body 里打的
   `tools[].cache_control` 在转换时被静默丢弃。因此 `has_marker` 恒 false，
   `:2406-2410` 的「已有 marker 就不追加」分支永不可达（死分支），
   尾块自动 ephemeral 无条件生效。
3. **四槽预算无核算**：当前打点面 = 顶层非标 `cache_control` 请求字段
   （`:2489-2491`，`AnthropicRequest.cache_control`，注释称 automatic mode，
   `:2825-2829`）+ system 尾保险断点（`:2378-2388`，调用方已有块级 marker 时
   跳过）+ tools 尾保险断点（`:2403-2410`）+ 调用方 system 块级 marker 原样
   保留（`extract_system_text_blocks` `:2914-2939`，数量不设限）。全文件
   无任何「块级断点计数 ≤ 4」的预算逻辑。现实压力：`model2_pipeline.rs:3665`
   只打 1 个 system 块 marker，叠加 tools 尾 = 2 个块级断点，实际未超标——
   但这是**巧合安全**而非受控安全；消息尾（对话前缀）断点缺位也意味着四槽
   只用了两槽，长对话增量缓存收益未拿到（归 #1 调研深挖）。

### 现有测试

- **死分支与槽位预算本身：零测试**。没有任何测试构造
  `tools[].cache_control` 输入验证保留（事实上会失败，因为被丢弃）；
  没有任何测试断言块级断点总数上限。
- 相邻的 P2-11 测试 2 个（只固化现状自动打点，不覆盖本项缺口）：
  - `anthropic_adds_tools_and_system_tail_cache_breakpoints`
    （`providers/mod.rs:5540`）：顶层保留 + system 尾 + tools 尾各一个
    ephemeral、非尾块不打点；
  - `anthropic_preserves_caller_block_level_system_cache_control`（`:5587`）：
    调用方 system 块级 marker 原样保留、不追加。

### 第 5 轮建议

1. **消死分支**：让 `convert_tool_definition` 透传输入里的
   `cache_control`（`:3243-3278` 加一行读取），`:2405` 的 has_marker 检查
   即活化；或者删掉恒 false 检查并注释「转换层不承接调用方工具 marker」——
   二选一，不许保留现在这种自欺形态。
2. **补槽位预算门控**：在 `convert_openai_to_anthropic` 收口处统计块级
   ephemeral 总数（system 块 + tools 块 + 未来消息块），>4 时从最靠前的
   低价值 marker 开始降级剥除，并配快照测试固化「4 槽满载 + 超载剥除」两例。
3. **补消息尾断点设计评估**（与 #1 调研合流）：对话历史稳定前缀尾打第 3 槽，
   留第 4 槽给增量，才是官方推荐的递进式缓存用法。

---

## 五、「55846040 实际改了什么」vs「评审原诉求」对照

| 评审原诉求 | 55846040 实际改动 | 判定 |
| --- | --- | --- |
| P0：breakpoint 用官方对象形状 `{"mode":"explicit"}` | `:1563` 布尔 → 对象形状；测试改为整包 wire body 快照（`:5091`） | 诉求满足 |
| P0：端点门控（非官方端点不发未知字段） | 新增 `is_official_openai_api_endpoint`（`:130`）+ `endpoint_supports_prompt_cache_breakpoint`（`:758`），注入条件三与（`:1552-1554`）；`convert_to_responses_format_for_endpoint` 带 base_url 入参 | 诉求满足 |
| （评审未点名，顺带）模型名子串误报 | `model_supports_prompt_cache_breakpoint` 重写为完整型号段解析（`:723-756`），负例测试补 2 条 | 超出诉求的加固 |
| P1：finish_reason 不得提前 Done 吞掉 usage-only 块 | `OpenAIAdapter` 有状态化 + `finish_stream()` trait 钩子 + `model2_pipeline.rs:5011` EOF 接线；测试 3 改 2 增 | 诉求满足 |
| P1：`stream_options` 不得无条件下发 | 注入加官方端点门控（`:163-166`）；测试改名扩负例（`:6118`） | 诉求满足（残余：白名单过窄，见第三节建议） |
| P2：Anthropic 四槽预算 + 工具 marker 死分支 | **未触及**。providers/mod.rs 的 Anthropic 段零改动 | 诉求未满足 |
| （评审外）Mythos 5 代际识别 | `adapters/anthropic.rs`：FAMILIES 加 `mythos`、adaptive/always-on 归入、新测试 `test_restricted_mythos_5_uses_always_on_adaptive_thinking`（:758） | 与四项无关的搭车改动，本身自洽 |
| （评审外）`OpenAIAdapter` 单元结构体 → 构造函数 | commands.rs / builtin_vendors.rs / llm_manager/mod.rs / streaming_harness.rs 共 4 处 `OpenAIAdapter` → `OpenAIAdapter::new()` | 有状态化的机械跟改 |

「308 行零测试验证」的说法需要更正为：**提交自带 12 个新增/改写的
`#[cfg(test)]` 测试源码**（P0 2 个、P1 终止 4+1 个、stream_options 1 个、
Mythos 2 个、机械跟改若干），但按本轮硬规则**从未执行过**（cargo test 未跑，
Step 23 四门禁只含 cargo check）。「零验证」成立，「零测试」不成立。

## 六、与四项相关的现有测试总数

providers/mod.rs 内 9 个：
`openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated`、
`model_supports_prompt_cache_breakpoint_parses_gpt_versions`、
`openai_adapter_emits_usage_before_done_for_official_chunk_sequence`、
`openai_adapter_bare_ndjson_finish_reason_completes_at_eof`、
`openai_adapter_finish_reason_ignores_empty_and_partial_multi_choice_completion`、
`stream_completion_requirement_matches_adapter_protocols`、
`openai_adapter_gates_stream_options_include_usage_by_endpoint`、
`anthropic_adds_tools_and_system_tail_cache_breakpoints`、
`anthropic_preserves_caller_block_level_system_cache_control`。

相邻 4 个：`openai_compatible_emits_usage_and_done`（harness:654）、
`codex_stream_requires_an_explicit_terminal_success`、
`openai_responses_api_key_stream_requires_an_explicit_terminal_success`、
`provider_incomplete_reason_takes_precedence_over_terminal_success`
（model2_pipeline:1344/1355/1365）。

合计 **9 + 4 = 13 个**（全部只是源码存在、本轮未执行）。
P2 死分支与四槽预算**零针对性测试**。
