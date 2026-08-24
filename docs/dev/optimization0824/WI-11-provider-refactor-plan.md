# WI-11：Provider 协议归一 —— model2_pipeline 审计与重构计划

> 子代理：SA-R3-08（只读分析，未改任何 Rust 逻辑）
> 模型：`claude-fable-5-thinking-xhigh`
> 分支：`cursor/optimization0824-5575`
> 审计对象：`src-tauri/src/llm_manager/model2_pipeline.rs`（6901 行，基于 commit `1bf03a24`）
> 关联上下文：`llm_manager/mod.rs`（协议分发）、`llm_manager/adapters/`（方言适配器）、
> `providers/mod.rs`（传输适配器）、`reasoning_policy.rs`（思维链回传策略）
> 阶段状态：**阶段 1（11-1a～11-1d）已由 SA-WRAP-WI11 落地（2026-08-24）**

## 0. 结论速览

- **传输层的 4 协议骨架已经存在**：`mod.rs::build_provider_adapter` 按
  `effective_api_protocol_for_config` 精确映射到 4 个 `ProviderAdapter`
  （`OpenAIAdapter` / `OpenAIResponsesAdapter` / `AnthropicAdapter` / `GeminiAdapter`），
  model2_pipeline 的 8 个出口全部经由该入口构建请求。**协议归一不需要从零发明抽象。**
- **问题在协议判定之外的散装特判**：model2_pipeline 内约 30 处 provider 分支
  （MiMo / Mistral / Qwen / DeepSeek 官方 / Codex OAuth / Gemini / GPT 模型名嗅探），
  以「config 字段嗅探 + base_url 子串 + 模型名前缀」三种脆弱方式做判定，
  且 HTTP 发送样板（UA/Origin/Referer/重试/Codex 分支）在 7 个出口重复复制。
- **迁移策略**：先把嗅探收口成声明式 quirks（阶段 1），再按协议归一请求组装（阶段 2），
  然后统一传输与流解析（阶段 3），最后删除遗留启发式并加契约门禁（阶段 4）。
  每阶段行为不变量由现有 60+ 单测（本文件内嵌 tests 模块 + `streaming_harness.rs`）守护。

## 1. Provider 分支清单

行号基于 commit `1bf03a24` 的 `src-tauri/src/llm_manager/model2_pipeline.rs`。

### 1.1 判定函数（config 嗅探）

| # | 位置 | 函数 | 判定依据 | 脆弱点 |
| --- | --- | --- | --- | --- |
| S1 | L365-372 | `is_qwen_config` | `provider_type` / `model_adapter` == `qwen` | 无 |
| S2 | L479-493 | `is_mimo_config` | `provider_scope`/`provider_type`/`model_adapter` == `mimo`，或 base_url 含 `xiaomimimo.com`，或模型名前缀 `mimo-v` | base_url 子串 + 模型名前缀 |
| S3 | L495-510 | `is_mistral_config` | provider 字段 == `mistral`，或 base_url 含 `mistral.ai`，或模型 slug 前缀 `mistral-`/`magistral-` | 同上 |
| S4 | L590-592 | `is_mimo_endpoint(model, base_url)` | 仅模型名 + base_url（无 config 可用的连通性测试场景） | 与 S2 逻辑重复 |
| S5 | L395-413 | `server_side_web_search_enabled` | `supports_tools` + Responses 协议 + `is_official_deepseek_config`（mod.rs L2937）+ 会话开关 | 组合门控，依赖 mod.rs |
| S6 | L2185-2187 | `LLMManager::is_openai_codex_oauth` | `auth_mode == "openai_codex_oauth"` | 无（显式声明，理想形态） |
| S7 | L1723-1765 | `apply_runtime_reasoning_overrides` 内联判定 | `openai_codex` provider、模型名含 `gpt-5`/`codex`/`gpt-oss`/o1-o3-o4 家族、`gpt-5.1`~`5.6` 白名单 | **最重的模型名嗅探**，OpenAI 每发新模型需改代码 |

### 1.2 请求体构建分支

| # | 位置 | 分支 | 行为 | 归属协议 |
| --- | --- | --- | --- | --- |
| B1 | L512-533 | `apply_generation_token_limit` | MiMo → `max_completion_tokens`；Mistral → 强制 `max_tokens`（reasoning 也不换字段）；`is_reasoning` → `max_completion_tokens`；否则 `max_tokens` | OpenAI CC 字段方言 |
| B2 | L535-551 | `apply_max_tokens_or_mimo_completion_limit` | B1 的旧路径变体（OCR/Anki 用），仅分 MiMo / 非 MiMo | OpenAI CC |
| B3 | L553-569 | `apply_generation_params` | 采样参数仅注入「非 reasoning 或 MiMo」 | OpenAI CC |
| B4 | L571-588 | `attach_reasoning_passback_payload` | 按 `ReasoningPassbackPolicy`：DeepSeekStyle → `reasoning_content` 字符串；ReasoningDetails → `reasoning_details` 数组；NoPassback | OpenAI CC（DeepSeek/xAI/GLM/Kimi 方言）+ Google（经 OpenRouter） |
| B5 | L594-623 | `build_test_chat_request_body` | MiMo 测试体带 `thinking: disabled` + `max_completion_tokens` | OpenAI CC |
| B6 | L455-462 | `remove_thinking_fields_for_tool_compat` | 移除 `enable_thinking`/`thinking_budget` 等 4 个厂商 thinking 字段（配合 adapter 的 `should_disable_thinking_for_tools`，L3452-3463） | OpenAI CC（Qwen/GLM 系） |
| B7 | L2625-2630 | system 消息 content array + `cache_control: ephemeral` | OpenAI/DeepSeek/Anthropic prompt caching 通用形态 | 三协议共用 |
| B8 | L2680-2703、L2899-2945 | 工具调用/历史消息 thinking 块格式化 | `request_adapter_for_config` + `format_tool_call_message`/`requires_thinking_in_history`（Anthropic 自定义 content blocks） | Anthropic |
| B9 | L2946-2979 | 纯 assistant 历史思维链回传 | DeepSeekStyle vs ReasoningDetails（Gemini 3 需附 `thoughtSignature`） | OpenAI CC + Google |
| B10 | L3008-3015 | `merge_consecutive_user_messages` | 注释明确针对 Anthropic/ERNIE 连续 user 报错 | Anthropic + OpenAI CC（ERNIE） |
| B11 | L3100-3104、L3122-3128 | DeepSeek 官方 Responses 注入服务端 `web_search` 工具 | 替换本地 function 版工具 | OpenAI Responses |
| B12 | L3111-3118、L3133-3140 | Qwen tool-result 追问请求移除 `tool_choice` | 官方 Function Calling 指南要求 | OpenAI CC（Qwen 方言） |
| B13 | L6013-6015、L6674-6676 | `gpt-` 前缀模型强制 `response_format: json_object` | raw prompt / Anki 两处重复 | OpenAI CC/Responses（模型名嗅探） |
| B14 | L6250-6286 | OCR 路径：DeepSeek-OCR 图片先于文本、`ZhipuAdapter::supports_thinking_static` 注入 GLM `thinking` 参数 | 直接引用具体 adapter 类型（打破抽象） | OpenAI CC |
| B15 | L4805-4845 | 非流式路径 `is_reasoning` → system 并入 user 消息 | 与流式路径（统一 system role，L2622-2630）**行为不一致** | OpenAI CC |

### 1.3 传输 / 认证分支

| # | 位置 | 分支 | 行为 | 归属协议 |
| --- | --- | --- | --- | --- |
| T1 | L1907-2182 | Codex OAuth 整套传输桥（`CodexPreparedAuth`、`rebuild_codex_response`、`normalize_codex_error_response`、`bridge_codex_nonstream_response` 等 9 个函数） | 401 单次刷新重试、404→429 usage-limit 映射、SSE→JSON 非流式桥接、错误体脱敏 | OpenAI Responses（Codex 变体） |
| T2 | L2228-2273 | `prepare_provider_request` | 统一入口：adapter.build_request + 自定义 header 合并；Codex 分支重写 URL/body/headers 并强制 Responses 协议（L2247-2251） | 全部 |
| T3 | L2294-2350 | `send_codex_request_with_single_refresh`（流式/非流式两个变体） | Codex 专用发送循环 | Responses（Codex） |
| T4 | L3527-3557 | 流式建连：非 Codex 才附加浏览器伪装 UA/Accept + Origin/Referer | Codex 用 OAuth header 集 | 全部 |
| T5 | L3622-3645 | 建连状态码：Codex 401 刷新/重登、403 专用文案 | 与通用 401/403（L3693-3715）并列 | Responses（Codex） |
| T6 | L4982-5027、L5246-5286、L6055-6101、L6319-6334、L6424-6445、L6701-6747 | **6 个非流式出口各自复制**「Codex 分支 + UA/Origin/Referer + send + 状态码处理」样板 | 非流式、metadata、raw prompt、OCR、convert_image、Anki | 全部 |
| T7 | L668-694 及全部日志调用点 | `sanitize_url_for_log` | Gemini 把 API key 放 query（`?key=AIza...`），所有 URL 出口必须脱敏 | Google |

### 1.4 流解析 / 终止语义分支

| # | 位置 | 分支 | 行为 | 归属协议 |
| --- | --- | --- | --- | --- |
| P1 | L272-352 | `provider_stream_failure_message` / `responses_stream_interruption_message` / `validate_stream_termination` | 错误文案三分：Codex / OpenAI Responses / 通用；Responses 系要求显式终止事件 | Responses vs 其余 |
| P2 | L3466-3470 | `build_provider_adapter` + `requires_explicit_stream_completion` | Responses（含 Codex）EOF 无终止事件 → 判定失败；CC/Anthropic/Gemini EOF 容忍 | 全部 |
| P3 | L3944-3964 | `adapter.parse_stream` + `[DONE]` 后备检测 | OpenAI CC 用 `data: [DONE]`；其他协议由 adapter 产生 `Done` 事件 | OpenAI CC |
| P4 | L4013-4023 | `StreamEvent::ThoughtSignature` | Gemini 3 思维签名缓存回传（工具调用必需） | Google |
| P5 | L4158-4180 | `StreamEvent::WebSearchCall` | DeepSeek Responses 服务端搜索事件 → hook + legacy 事件 | Responses |
| P6 | L4387-4449 | 流结束后 pending 工具调用兜底 finalize | 注释明确：Gemini 原生 SSE 不发 `[DONE]` | Google |
| P7 | L6483-6588 | `extract_usage_tokens` | 四套 usage 字段名：OpenAI `prompt_tokens`、Anthropic `input_tokens`/`cache_read_input_tokens`、Gemini `promptTokenCount`/`thoughtsTokenCount`、DeepSeek `prompt_cache_hit_tokens`，cached 取 max 防中转站重复 | 全部 |
| P8 | L5050、L5305、L6137、L6352、L6468、L6764 | `normalize_nonstream_response_to_openai`（mod.rs L3129） | 非流式响应归一到 OpenAI chat 形状（含 Gemini 安全错误、Anthropic refusal 检查） | 全部 |

### 1.5 游离在抽象之外的 ad-hoc 分发（重点技术债）

| # | 位置 | 问题 |
| --- | --- | --- |
| X1 | L5534-5546 | `test_chat_model` 不走 `build_provider_adapter`，用「模型名含 `claude`/`anthropic` → AnthropicAdapter；含 `gemini` 或 base_url 含 `generativelanguage` → GeminiAdapter；否则 OpenAIAdapter」的内联三分支，且 L5601-5605 再内联一次 Gemini 响应转换 |
| X2 | L5517-5526 | 连通性测试模型候选硬编码 `gpt-3.5-turbo` / `Qwen2-7B` / `Llama-2-7b` |
| X3 | L6373-6473 | `convert_image_to_markdown` 已标 DEPRECATED（`#[allow(dead_code)]`），仍保有一整套发送样板 |
| X4 | S7（L1713-1790） | 运行期推理开关的 OpenAI 模型名白名单，是全文件最频繁需要跟随上游发版更新的分支 |

## 2. 四协议映射

`mod.rs::effective_api_protocol_for_config`（L2946）已经把所有 config 归一到 4 个协议字符串，
这是迁移的**锚点**。下表给出每个协议的成员、传输适配器与 model2_pipeline 内的专属分支。

### 2.1 协议 → 传输适配器（现状，mod.rs L3121-3126）

| 协议 | `ProviderAdapter` | 流终止语义 | 非流式归一 |
| --- | --- | --- | --- |
| `openai_chat_completions` | `OpenAIAdapter` | `data: [DONE]`（P3），EOF 容忍 | `normalize_openai_nonstream_response` |
| `openai_responses` | `OpenAIResponsesAdapter` | 必须收到 `response.completed`（P1/P2） | Responses JSON → chat 形状 |
| `anthropic_messages` | `AnthropicAdapter` | `message_stop` → `Done` | `convert_anthropic_response_to_openai`（含 refusal 检查） |
| `google_generate_content` | `GeminiAdapter` | 无 `[DONE]`，EOF 兜底 finalize（P6） | `gemini_openai_converter`（含安全错误检查） |

### 2.2 Provider / 方言 → 协议归属

方言适配器注册表见 `llm_manager/adapters/mod.rs` L201-234（`RequestAdapter`，管请求体方言），
与传输适配器（`ProviderAdapter`，管 URL/header/流解析）正交。

| 协议 | 成员（provider_type / 方言） | model2_pipeline 专属分支 |
| --- | --- | --- |
| **OpenAI Chat Completions**（默认兜底） | generic/openai 第三方、siliconflow、nvidia、**mimo**、**mistral**、**qwen**、deepseek（官方 V3.x/V4-Pro + 全部第三方托管）、zhipu/GLM、doubao、moonshot/kimi、ernie/baidu、minimax、grok/xai、openrouter 等聚合平台、perplexity | S1-S4、B1-B6、B10（ERNIE）、B12、B13、B14、B15、P3、X1、X2 |
| **OpenAI Responses** | 官方 OpenAI（api.openai.com 默认切换）、**Codex OAuth**（强制，T2）、官方 DeepSeek `deepseek-v4-flash`/`deepseek-chat`/`deepseek-reasoner`（mod.rs L2925-2932 白名单）、显式声明 `supports_openai_responses=true` 的网关 | S5、S6、S7、T1、T3、T5、B11、P1、P2、P5 |
| **Anthropic Messages** | anthropic、claude（model_adapter 原生协议，mod.rs L2833-2838） | B8、B10、P7（`input_tokens`/`cache_read_input_tokens`）、P8、X1 |
| **Google generateContent** | google、gemini（同上原生协议） | B9（thoughtSignature）、T7、P4、P6、P7（`promptTokenCount` 系）、P8、X1 |

### 2.3 跨协议横切策略（不归属单一协议，需独立收口）

| 策略 | 现状载体 | 说明 |
| --- | --- | --- |
| 思维链回传三态 | `reasoning_policy.rs`（OpenRouter/Perplexity/Google 特例 + adapter 委托） | B4/B9 消费；OpenRouter 会把 Gemini/o 系/GPT-5/Kimi 输出统一改写为 `reasoning_details`，即**同一模型经不同网关归属不同回传格式** |
| max_tokens 字段选择 | B1/B2 双实现 | MiMo/Mistral/reasoning 三向分裂，应为 quirk 表单字段 |
| usage 字段名 | P7 单函数 | 已经是表驱动雏形，保留 |
| prompt caching | B7 + P7 cached 提取 | OpenAI/DeepSeek/Anthropic/Gemini 四家字段各异 |
| thinking 参数互斥 | B6 + adapter `should_disable_thinking_for_tools` | Qwen/GLM 系工具调用与 thinking 冲突 |

## 3. 四阶段迁移计划

原则：每阶段独立可合并、行为等价（除明确列出的 bug fix）、现有单测全绿 +
每阶段新增快照测试。阶段间无回滚耦合——任何阶段完成后停下，代码库都处于比之前更好的状态。

### 阶段 1：嗅探收口 —— 声明式 ProviderQuirks（已完成）

**目标**：把 §1.1 全部判定函数和 §2.3 横切策略收进单一 `provider_quirks` 模块，
从 `ApiConfig` 一次解析出不可变 quirks 结构体，model2_pipeline 只消费字段、不再嗅探。

```rust
// 目标形态（示意）
pub(crate) struct ProviderQuirks {
    pub max_tokens_field: MaxTokensField,      // MaxTokens | MaxCompletionTokens
    pub sampling_params_allowed: bool,          // B3
    pub strip_tool_choice_on_tool_result: bool, // B12 (qwen)
    pub server_side_web_search: bool,           // S5/B11
    pub force_json_response_format: bool,       // B13 (gpt-*)
    pub reasoning_passback: ReasoningPassbackPolicy, // B4/B9
    pub merge_consecutive_user: bool,           // B10
    // ...
}
pub(crate) fn resolve_quirks(config: &ApiConfig) -> ProviderQuirks;
```

**可派发 work items**：

| WI | 内容 | 验收 |
| --- | --- | --- |
| 11-1a | 新建 `llm_manager/provider_quirks.rs`：迁入 S1-S4 判定 + B1/B2/B3 的 max_tokens/采样决策，quirks 结构体 + `resolve_quirks`；为每个字段写「判定依据 → 期望值」单测矩阵（MiMo/Mistral/Qwen/DeepSeek 官方/第三方各一组） | `cargo test -p` 全绿；model2_pipeline 的 `is_mimo_config`/`is_mistral_config`/`is_qwen_config`/`is_mimo_endpoint` 调用点全部改为读 quirks，函数本体删除 |
| 11-1b | B4/B9 回传策略消费点改读 quirks（quirks 内嵌 `reasoning_policy::get_passback_policy` 结果）；B13 两处 `gpt-` 嗅探合并为 quirk 字段 | 现有 reasoning_policy 测试不动、全绿 |
| 11-1c | S7 `apply_runtime_reasoning_overrides` 的 OpenAI 模型名白名单抽成 quirks 内的数据表（`FORCED_REASONING_MODEL_PATTERNS` 常量数组），逻辑不变 | 本文件 L1507-1628 的 5 个现有测试全绿 |
| 11-1d | 审计快照测试：对代表性 config（4 协议 × 官方/第三方 × reasoning 开关）固化 `resolve_quirks` 输出 + `prepare_provider_request` 产物（URL/headers 键集/body 键集），作为后续阶段的回归基线 | 新增 snapshot 测试落盘 |

**风险**：低。纯移动 + 表驱动化；快照基线（11-1d）是后续所有阶段的安全网，必须先行合并。

#### 阶段 1 完成记录（SA-WRAP-WI11）

- [x] **11-1a**：新增 `llm_manager/provider_quirks.rs`，统一 S1～S4、
  B1～B3 的判定；model2 已删除散装 `is_qwen_config`、`is_mimo_config`、
  `is_mistral_config`、`is_mimo_endpoint`。
- [x] **11-1b**：B4/B9 改读 `reasoning_passback` /
  `passback_plain_assistant_reasoning`，B13 两处改读
  `force_json_response_format`。
- [x] **11-1c**：S7 改为 `RuntimeReasoningOverride`，强制推理模型模式由
  `FORCED_REASONING_MODEL_PATTERNS` 及相邻边界表集中维护。
- [x] **11-1d**：固化 4 协议 × 官方/第三方 × reasoning 开关共 16 组
  quirks 快照，以及对应 `prepare_provider_request` URL、header 键集、body 键集快照：
  - `llm_manager/snapshots/provider_quirks_phase1.json`
  - `llm_manager/snapshots/provider_requests_phase1.json`

阶段 2～4 保持未开始；本轮未改 `chat_v2/pipeline/tool_loop.rs`。

### 阶段 2：请求组装归一 —— 每协议一个 RequestBuilder

**目标**：消灭 model2_pipeline 内对 `request_body` 的散装 `json!` 突变。
中立请求描述（messages / tools / reasoning 意图 / 生成参数）+ quirks 进入
按协议分派的 builder，历史消息序列化（B8/B9/B10、工具调用合并）随之下沉。

**可派发 work items**：

| WI | 内容 | 验收 |
| --- | --- | --- |
| 11-2a | 定义 `NeutralChatRequest`（messages 枚举 + tools + reasoning 意图 + 生成参数），流式出口（`call_unified_model_2_stream_with_config` L2599-3463 的组装段）改为先构建中立请求 | 快照 11-1d 不变 |
| 11-2b | OpenAI CC builder：吸收 B1-B6/B12/B13/B15；**顺带修复 B15 不一致**（非流式 reasoning 路径的 system 并入 user 与流式统一，单独 commit 标注行为变化） | 快照仅 B15 项按预期变化 |
| 11-2c | Responses builder：吸收 B11 + Codex body 准备（`prepare_codex_responses_body` 调用点）；Anthropic / Gemini builder：吸收 B8/B9/B10（thinking 块、thoughtSignature、连续 user 合并） | 快照不变 |
| 11-2d | 非流式 / metadata / raw prompt / OCR / Anki 五个出口切换到 builder；B14 的 `ZhipuAdapter::supports_thinking_static` 直接引用改为 quirk 字段 | 全部出口快照不变 |

**风险**：中。工具调用历史序列化（L2638-3006）是最复杂的段落，2c 需要
Anthropic/Gemini 真实流量样本比对（可用 `debug.persist_logs` 落盘的脱敏请求体做 fixture）。

### 阶段 3：传输与流解析归一 —— 单一 send + 终止语义表

**目标**：§1.3 的 7 份发送样板收敛为一个 `send_provider_request`
（含重试/退避/取消/状态码打标），Codex OAuth 降级为传输装饰器；
流循环消费协议无关的 `StreamEvent`，终止语义由每协议声明。

**可派发 work items**：

| WI | 内容 | 验收 |
| --- | --- | --- |
| 11-3a | 抽取 `ProviderTransport::send`（非流式）：合并 T6 的 6 份样板（UA/Origin/Referer/Codex 分支/failover 打标）；X3 deprecated 函数直接删除 | 6 个出口 diff 后仅剩 builder + send 调用 |
| 11-3b | 抽取流式建连段（L3518-3765：建连重试 + 429/5xx 退避 + Codex 401 刷新 + 取消轮询）为可复用的 `establish_stream`；T4/T5 分支进入 transport | 现有 429/5xx/取消行为测试全绿 |
| 11-3c | 终止语义表：`StreamTermination { requires_terminal_event, done_marker, eof_finalizes_tools }` 按协议声明，P1/P2/P3/P6 改为查表；P6 的 Gemini EOF 兜底 finalize 与 Done 分支的重复 finalize 代码（L4225-4279 vs L4389-4448）合并为单函数 | `streaming_harness.rs` + 本文件流测试全绿 |
| 11-3d | P7 usage 提取改为按协议的字段名表（保留取 max 防重复策略）；X1/X2：`test_chat_model` 改走 `build_provider_adapter` + 注册表默认测试模型 | 连通性测试对 4 协议各跑一次 mock 服务 |

**风险**：中高。3b 触碰取消/超时时序（P1-3、F2 修复所在地），必须保留
`STREAMING_REQUEST_TIMEOUT_SECS`/`STREAMING_IDLE_TIMEOUT_SECS` 语义与
`sleep_checking_cancel` 的 500ms 轮询；建议 3b 单独 PR + 人工流式冒烟。

### 阶段 4：遗留启发式清理 + 契约门禁

**目标**：删掉 base_url 子串与模型名嗅探的最后残留，判定全部来自
注册表（`provider_protocol_registry`）+ config 显式字段；建立 4 协议契约测试防回归。

**可派发 work items**：

| WI | 内容 | 验收 |
| --- | --- | --- |
| 11-4a | quirks 判定中 base_url 子串（`xiaomimimo.com`/`mistral.ai`/`api.deepseek.com`）迁入 provider_protocol_registry 数据；S7 模型名白名单改由模型注册表 capability 字段驱动，代码只留读取逻辑 | 嗅探字符串在 model2_pipeline/provider_quirks 中 grep 为零 |
| 11-4b | 4 协议契约测试：每协议一个 mock 服务（成功流/中断流/工具调用流/usage/错误码），跑「builder → transport → 流解析 → usage 提取」全链路；纳入 `rust-tests` job（非 provider-contract 重型 job） | CI 常规跑，单协议 < 30s |
| 11-4c | 清理：删除 `should_use_openai_responses`（L6898 薄封装）、合并 B2 进 B1、删除 X3；`docs/` 补一页 quirks 字段说明供后续新 provider 接入 | dead_code 告警为零 |
| 11-4d | 收尾复审：对照 §1 清单逐项勾销，未迁移项写明保留理由；更新 COORDINATION.md WI-11 状态 | 清单 100% 处置 |

### 阶段依赖与并行度

```
阶段1 (11-1a → 11-1b/1c 并行 → 11-1d)
  └→ 阶段2 (11-2a → 11-2b/2c 并行 → 11-2d)
       └→ 阶段3 (11-3a/3d 并行；11-3b → 11-3c)
            └→ 阶段4 (11-4a/4b 并行 → 11-4c → 11-4d)
```

- 每个 work item 尺寸按单子代理单轮可完成设计（改动集中在 1-3 个文件）。
- 阶段 1/2 不改网络行为，可与其他 WI 并行推进；阶段 3 涉及取消/超时时序，
  建议独占轮次并避开与 chat_v2 pipeline 改动同轮。
- 全程冻结区：`openai_codex.rs`（OAuth 桥另有归属）、`providers/mod.rs` 的
  4 个传输适配器内部解析逻辑（本计划只消费其接口）。
