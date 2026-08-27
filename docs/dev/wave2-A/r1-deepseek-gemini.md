# r1-#3 调研员-DeepSeek/Gemini：context caching、usage 口径与兼容网关 400 面

- 基线：`cursor/0824-wave2-agent-cache-a875` @ `44176988`（源自 `061b4815`）
- 检索日期：**2026-08-26**（所有 WebSearch / 引用均为当日检索）
- 范围：DeepSeek（CC + Responses）、Gemini（原生 generateContent 路径）、OpenAI 兼容网关的
  `stream_options` / `store` / `cache_control` / `prompt_cache_breakpoint` 400 行为，对照本仓实现。
- 只读调研，未改任何产品代码。

---

## 1. 官方口径：DeepSeek

### 1.1 Context Caching（硬盘缓存，全自动）

来源：[Context Caching | DeepSeek API Docs](https://api-docs.deepseek.com/guides/kv_cache)（2026-08-26 检索）

- 默认对所有用户开启，**无需任何请求参数**；不提供手动 cache key / retention 控制。
- 前缀重叠即命中：后续请求与此前请求有重叠前缀时，重叠部分从盘上缓存取，计为 cache hit。
- usage 中新增两个字段反映命中状态：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。

### 1.2 Chat Completions usage 字段

来源：[Chat Completions API | DeepSeek API Docs](https://api-docs.deepseek.com/api/create-chat-completion)（2026-08-26 检索）

| 字段 | 语义 |
|---|---|
| `prompt_tokens` | 输入总量，**恒等于 hit + miss** |
| `prompt_cache_hit_tokens` | 命中盘上缓存的输入 token（required） |
| `prompt_cache_miss_tokens` | 未命中的输入 token（required） |
| `completion_tokens` / `total_tokens` | 常规 |
| `completion_tokens_details.reasoning_tokens` | 思维链 token（可选） |

流式行为（重要）：**usage 恒定随最后一个内容 chunk 返回**（在 `data: [DONE]` 之前）；
`stream_options.include_usage=true` 只改变「其余 chunk 是否带 `usage: null`」，**不设置也能拿到 usage**。
没有独立的 usage-only chunk；末 chunk 的 `choices` 恰含一个元素、无新内容、`finish_reason` 非空。
→ 本仓「只对 api.openai.com 注入 `stream_options`」的门控（见 §5.1）不会丢 DeepSeek CC 的 usage。

CC schema 注意：**system 消息的 `content` 是 `string` required**；user 消息 2026 版 schema 才有
"Array of content parts"（text/image/file）。历史与现行行为一致：给 DeepSeek CC 发分块数组会 400
（见 §5.3 证据）。

### 1.3 Responses API（无状态公测）usage 与参数矩阵

来源：[Using the Responses API | DeepSeek API Docs](https://api-docs.deepseek.com/guides/responses_api/)、
[Responses API | DeepSeek API Docs](https://api-docs.deepseek.com/api/create-response/)（2026-08-26 检索）

- usage：`input_tokens`，其中 `input_tokens_details.cached_tokens` = 命中上下文缓存的输入 token；
  `output_tokens`，其中 `output_tokens_details.reasoning_tokens` = 思维链 token。
  **没有** `cache_write_tokens`（缓存写不单独计量，写入按 miss 价计费）。
- 参数矩阵（官方兼容表）：
  - `previous_response_id` / `conversation`：不支持（无状态，历史需客户端全量回传）。
  - `store`：不支持，响应恒返回 `store: false`；`stream_options`：不支持；
    `prompt_cache_key` / `prompt_cache_retention`：不支持（缓存全自动）；
    `include` / `metadata` / `background` / `service_tier`：不支持。
  - **不支持的参数被静默忽略、不报错**——官方明说是为兼容既有 Responses 客户端。
  - `truncation`：不支持；**超 1M 上下文直接 400，不做截断**。
  - 模型面：仅 `deepseek-v4-flash` 系列（`deepseek-v4-pro` 官方宣布 2026-08 初上线，
    另见 [apidog 解读](https://apidog.com/blog/deepseek-v4-flash-responses-api-codex/)，2026-08-26 检索）。

### 1.4 网关侧 DeepSeek 缓存价（参考）

[OpenRouter Prompt Caching 博客](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/)
（2026-08-26 检索）：DeepSeek cache read 0.1x input、cache write 1.0x input（即写不加价）、全自动启用。

---

## 2. 官方口径：Gemini

### 2.1 隐式缓存（默认开）

来源：[Context caching | Google AI for Developers](https://ai.google.dev/gemini-api/docs/generate-content/caching)、
[Interactions API 版](https://ai.google.dev/gemini-api/docs/interactions/caching)（2026-08-26 检索）

- Gemini 2.5 及更新模型**默认开启隐式缓存**，无需任何请求参数；命中自动折价（无节省保证）。
- 最小可缓存输入：Gemini 2.5 Flash/Pro = 2048 tokens；Gemini 3.5 Flash / 3.1 Pro Preview = 4096
  （Vertex 侧：Gemini 3 家族 4096，3.0 Flash Preview / 3.1 Pro Preview 隐式 6144）。
- 提升命中率的官方建议：**大而稳定的内容放 prompt 开头**、相似前缀请求在短时间内发送——与本仓
  「稳定前缀/动态后缀」工作方向一致。
- 命中数在响应 `usage_metadata`（generateContent）；注意 **Interactions API 用的是
  `usage.total_cached_tokens`**，字段名不同。

### 2.2 显式缓存（cachedContents）

来源：同上 + [Vertex AI context caching 概览](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)（2026-08-26 检索）

- 手动 `cachedContents` CRUD，请求时以资源名引用（请求体 `cachedContent` 字段）；TTL 默认 1 小时，可改。
- 折价保证：Gemini 2.5+ 缓存 token 90% 折扣（2.0 为 75%）；创建缓存按标准 input 价一次性计费。
- 隐式/显式命中都反映在 `usageMetadata.cachedContentTokenCount`。

### 2.3 usage 字段（generateContent）

| 字段 | 语义 |
|---|---|
| `usageMetadata.promptTokenCount` | 输入总量（**含**缓存命中部分） |
| `usageMetadata.candidatesTokenCount` | 输出 |
| `usageMetadata.totalTokenCount` | 总量 |
| `usageMetadata.thoughtsTokenCount` | 思维 token（2.5/3 思维开启时） |
| `usageMetadata.cachedContentTokenCount` | 缓存命中（隐式+显式统一入口） |

Gemini **没有 cache write 字段**（隐式写按标准 input 价，无附加费）。

---

## 3. 三家 usage 字段名对照（缓存命中 / 缓存写 / 思维链）

「命中语义」三家一致：命中数是输入总量的**子集**（`prompt/input_tokens` 含命中部分），
本仓四处解析器统一按「字段存在即已测量、显式 0 = 真实 miss、多格式取 max 防网关重复」处理，口径正确。

| 供应商/协议 | 输入总量 | 缓存命中 | 缓存写 | 思维链 |
|---|---|---|---|---|
| DeepSeek CC | `prompt_tokens`（= hit+miss） | `prompt_cache_hit_tokens`（顶层） | 无 | `completion_tokens_details.reasoning_tokens` |
| DeepSeek Responses | `input_tokens` | `input_tokens_details.cached_tokens` | 无 | `output_tokens_details.reasoning_tokens` |
| OpenAI CC | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | 无（GPT-5.6 前写免费） | `completion_tokens_details.reasoning_tokens` |
| OpenAI Responses | `input_tokens` | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens`（GPT-5.6+） | `output_tokens_details.reasoning_tokens` |
| Gemini generateContent | `promptTokenCount` | `cachedContentTokenCount` | 无 | `thoughtsTokenCount` |
| Gemini Interactions API | — | `usage.total_cached_tokens`（字段名不同！） | 无 | — |
| Anthropic（参照） | `input_tokens`（不含缓存段） | `cache_read_input_tokens` | `cache_creation_input_tokens` | 无独立字段 |
| 聚合网关（LiteLLM 归一） | OpenAI 形态 | `prompt_tokens_details.cached_tokens` | 透传 `cache_creation_input_tokens`（仅 Anthropic） | `completion_tokens_details.reasoning_tokens` |

来源：§1、§2 官方文档 + [LiteLLM Prompt Caching](https://docs.litellm.ai/docs/completion/prompt_caching)（2026-08-26 检索）。

**本仓覆盖点**（四处解析器全部覆盖上表除 Interactions API 外的所有命中字段）：

- `src-tauri/src/providers/mod.rs:3380-3483`（`build_usage_event`）：
  DeepSeek CC `prompt_cache_hit_tokens` :3413-3416；Gemini 顶层 `cached_tokens` :3417-3420
  （由转换器抬升，见下）；Responses `input_tokens_details.cached_tokens` :3408-3412；
  cache write 三形态 :3432-3454；reasoning 三形态 :3456-3469。
- `src-tauri/src/llm_manager/model2_pipeline.rs:7701-7770`（`extract_usage_tokens`）：同口径，
  另兼容 Gemini 原始 camelCase `thoughtsTokenCount` :7706、`promptTokenCount/candidatesTokenCount`
  :7676-7690。
- `src-tauri/src/chat_v2/pipeline/llm_adapter.rs:86-153`（`parse_api_usage`）：同口径。
- `src-tauri/src/llm_manager/exam_engine.rs:675-683`：OCR 路径兼容 `prompt_cache_hit_tokens`。
- Gemini 抬升：`src-tauri/src/adapters/gemini-openai-converter.rs:1106-1157`（流式）与
  :1388-1428（非流式）把 `cachedContentTokenCount` 抬到顶层 `cached_tokens`、
  `thoughtsTokenCount` 抬到 `reasoning_tokens`，且**无缓存字段时不注入**（避免伪 0），有测试
  :2216-2249 锁定。
- 落库契约：`src-tauri/src/llm_usage/types.rs:167-179`（`cached_tokens` / `cache_write_tokens`，
  NULL=未测量 ≠ 0），与 `docs/dev/0824-rel-llmusage.md` 的「presence 即测量」修复一致。

**口径小瑕疵**（不构成错账，但值得知道）：

- `prompt_cache_miss_tokens` 全仓不读——无需读（hit 已够，miss = prompt - hit），仅记录。
- `gemini-openai-converter.rs:1128,1410` 的兜底字段 `cacheReadInputTokens` 不是任何官方
  Gemini 字段（疑似臆造/网关变体），无害但属噪声。
- Gemini Interactions API 的 `usage.total_cached_tokens` 无解析——本仓未接该 API，暂不构成缺口。

---

## 4. 本仓 DeepSeek / Gemini 路径现状（锚定）

### 4.1 DeepSeek

- 官方判定：`src-tauri/src/llm_manager/mod.rs:3047-3053`（`is_official_deepseek_config`）
  **已校验 base_url host == api.deepseek.com**，反代不再被当官方（含 path 走私用例，测试
  :1031-1060）。`docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md:23`「只看
  provider_type」的指控**已过时/已修**。
- 协议路由：`mod.rs:3055-3105` 官方 DeepSeek 按模型列名开 Responses
  （`deepseek_model_supports_openai_responses` :3022-3031，flash/pro/flash-vision-exp +
  legacy 别名）；V3.x 显式或默认都回落 CC，避免 404。ROUND-01-cache-prefix.md:22
  「默认协议缺模型门控」**已修**。
- Responses 请求：`providers/mod.rs:1578-1580` `store` 缺省强制 `false`（官方静默忽略，见 §1.3，
  安全）；`prompt_cache_key` **不写给** DeepSeek 官方
  （`model2_pipeline.rs:3181-3187`，测试 :1176-1183）；`prompt_cache_breakpoint` 被模型
  （GPT-5.6+，:721-756）+ 端点（api.openai.com，:758-760）双重门控，DeepSeek 拿不到
  （测试 :5190），与官方「不支持、自动缓存」一致。
- 无状态回放：web_search_call 完整 item 回传（`providers/mod.rs:1322-1344, 1506-1518`）、
  reasoning passback DeepSeekStyle（`model2_pipeline.rs:769`），与官方无状态模型匹配。
- 服务端 web_search 门控：`provider_quirks.rs:40-41,164-166` + `model2_pipeline.rs:573-607`
  仅官方 + Responses + 列名模型注入。

### 4.2 Gemini

- `providers/mod.rs:3626-3728`（`GeminiAdapter`）→ `adapters/gemini-openai-converter.rs`
  构建原生 generateContent 请求；usage 抬升见 §3。
- **隐式缓存依赖成立**：Gemini 2.5+ 默认开，本仓无需请求参数即可吃到折价；命中观测链
  （`cachedContentTokenCount` → `cached_tokens` → 落库）已通。
- **显式缓存（cachedContents / `cachedContent` 请求字段）完全未实现**——全仓无
  `cachedContent` 请求侧写入点。对照 LiteLLM 的做法（把 `cache_control` 标记段送
  `cachedContents` API 再回填 `cached_content`，最小 1024 tokens），这是可选增强而非缺陷：
  隐式缓存已覆盖主聊天场景，显式缓存适合「超大稳定语料 + 高频复用」的后台任务。

---

## 5. 兼容网关 400 面：官方/社区证据 × 本仓现状

### 5.1 `stream_options.include_usage`

外部证据（2026-08-26 检索）：

- Databricks AI Gateway 严格校验 JSON schema，未知字段直接 400：
  `json: unknown field "stream_options"`（[opencode #31156](https://github.com/anomalyco/opencode/issues/31156)、
  [continue #12936](https://github.com/continuedev/continue/issues/12936)——修复方向正是
  「仅 `apiBase === api.openai.com` 才注入」）。
- POE 代理部分模型：`Unknown parameter: 'stream_options.include_usage'`
  （[cherry-studio #11652](https://github.com/CherryHQ/cherry-studio/issues/11652)）。
- DeepSeek Responses：`stream_options` 列为「不支持、静默忽略」（§1.3）。

本仓现状：`providers/mod.rs:156-172` **只对 api.openai.com 官方端点自动注入**，未知网关不注入，
调用方显式设置时尊重原值；测试 :6118-6167 锁定三种情况。全仓无其他 `stream_options` 写入点
（grep 仅 providers/mod.rs 与 gemini 转换器的透传字段声明）。**已对齐业界修复方向，无 400 面**。
代价：非官方 CC 端点收不到注入——DeepSeek CC 无损（usage 恒在末 chunk，§1.2）；其他第三方 CC
网关若默认不回 usage，则流式缓存命中不可观测（观测缺口而非 400 缺口）。

### 5.2 `store`

- DeepSeek Responses：官方明确「不支持但静默忽略、恒返 `store:false`」（§1.3）→
  本仓 `providers/mod.rs:1580` 无条件写 `store:false` **对 DeepSeek 官方安全**；
  ROUND-01-cache-prefix.md:25 的担忧可降级为「已被官方兼容表豁免」。
- 残余风险：`store` 会发给**所有**第三方 Responses 网关
  （snapshot `llm_manager/snapshots/provider_requests_phase1.json:110-140` 证实
  `responses.example.com` 收到 `store` + `prompt_cache_key`）。`store` 是 Responses 标准参数，
  实现完整的网关都认；但按 Databricks 类「未知字段即 400」的严格实现风格，老版本 Responses
  网关存在低概率 400 面。**中低风险**。

### 5.3 `cache_control`（本仓最危险的 400 面）

外部证据（2026-08-26 检索）：

- 严格 OpenAI 兼容供应商对 content part 里的 `cache_control` 直接 400：
  `"Extra inputs are not permitted, field: 'messages[0].content.list[1].cache_control'"`——
  实锤名单：Fireworks 托管 Kimi/GLM、Azure Mistral
  （[pollinations #10672](https://github.com/pollinations/pollinations/issues/10672)，
  该网关最终在入口统一剥除 `cache_control`）。
- DeepSeek CC 对**分块数组 content 本身**就 400：
  `Failed to deserialize the JSON body into the target type: messages[N]: invalid type: sequence,
  expected a string`（[marimo #7036](https://github.com/marimo-team/marimo/issues/7036)、
  [vscode-ai-toolkit #264](https://github.com/microsoft/vscode-ai-toolkit/issues/264)、
  [langchain b1c7de9](https://github.com/langchain-ai/langchain/commit/b1c7de98f57bdd304699a05b79acc1953704fc72)）；
  官方 CC schema 中 **system.content 为 string required**（§1.2）。
- DeepSeek 的 `/anthropic` 端点对「system 为块数组 + cache_control」同样 400
  （[DeepSeek-V3 #1369](https://github.com/deepseek-ai/DeepSeek-V3/issues/1369)）。
- 反面（容忍侧）：OpenAI 官方接受 content 数组形态；OpenRouter/LiteLLM 把块级 `cache_control`
  作为**特性**消化（转 Anthropic/Google 原生缓存或 GPT-5.6+ `prompt_cache_breakpoint`，
  [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)、
  [LiteLLM](https://docs.litellm.ai/docs/completion/prompt_caching)）。

本仓现状：`model2_pipeline.rs:3662-3667` 给**每一个** model2 请求的 system 消息打
`content: [{type:"text", text, cache_control:{type:"ephemeral"}}]`，且：

- CC 路径 `OpenAIAdapter::build_request`（`providers/mod.rs:142-190`）的
  `sanitize_openai_request_body`（:614-651）**只清洗 tools/tool_choice，不剥 `cache_control`、
  不压平数组** → 原样上线。
- Responses 路径安全：`push_message_parts`（:848+）重建 parts，system 走顶层
  `instructions`（string），`cache_control` 自然丢弃。
- Anthropic 路径安全且正确（:2337-2408 保留块级标记）。

**受击面**：① 官方 DeepSeek V3.x（协议回落 CC，`mod.rs` 测试 :1870-1904 确认该路径存在）→
数组形态即 400，**确定性炸**；② SiliconFlow 等第三方 DeepSeek CC 托管（行为未知）；
③ Fireworks / Azure Mistral / Databricks 类严格网关 → `cache_control` 字段 400，**实锤名单**；
④ OpenAI 官方 / OpenRouter / LiteLLM → 容忍或消化，无恙。

### 5.4 `prompt_cache_breakpoint` / `prompt_cache_key` / `prompt_cache_retention`

- `prompt_cache_breakpoint`：模型 + 端点双门控（§4.1），只发 api.openai.com。**无 400 面**。
- `prompt_cache_key`：OpenAI 标准参数；本仓发给 OpenAI 官方 + **一切** Responses 协议端点
  （`model2_pipeline.rs:3181-3187`，测试 :1157-1191 明确网关也收）。DeepSeek 官方已被排除。
  老版 Responses 严格网关的低概率 400 面，与 `store` 同级。**中低风险**。
- `prompt_cache_retention` / `prompt_cache_options`：**死代码**——
  `model2_pipeline.rs:3193-3196`（`provider_accepts_prompt_cache_retention`）与
  :3205-3214（`apply_openai_prompt_cache_retention`）全仓零调用点（rg 仅命中定义）。
  没有 400 面，但意味着「OpenAI 24h 缓存保留」从未实际下发，注释宣称的 P0 缓存收益不存在。

### 5.5 工具 schema 严格校验（顺带发现）

- vLLM mistral tokenizer 对 `function.strict`（哪怕 `false`）400：
  `Extra inputs are not permitted [type=extra_forbidden]`
  （[vllm #27746](https://github.com/vllm-project/vllm/issues/27746)）；Databricks 还会拒
  `minimum/maximum` 等 JSON-schema 约束（opencode #31156 附带）。
- 本仓：Responses 工具转换**无条件补 `strict:false`**（`providers/mod.rs:1029-1035`），
  发往所有 Responses 端点（DeepSeek 官方静默忽略，安全；严格第三方 Responses 网关有
  400 面）。CC 路径不注入 `strict`，安全。本仓已有空工具名 400 防御
  （issue #53，测试 :4518-4576），说明这一类 400 面有先例、有处理惯例。

---

## 6. 差距清单（已对齐 / 半对齐 / 缺失）

| # | 项 | 状态 | 位置（文件:行号） | 说明 / 建议 |
|---|---|---|---|---|
| 1 | DeepSeek CC `prompt_cache_hit_tokens` 解析 | 已对齐 | providers/mod.rs:3413-3416；model2_pipeline.rs:7733-7735；llm_adapter.rs:109-111；exam_engine.rs:682 | 四处一致，max 归一防网关重复 |
| 2 | DeepSeek Responses `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens` | 已对齐 | providers/mod.rs:3408-3412, 3456-3469 | usage 夹具测试 :6054+ |
| 3 | Gemini `cachedContentTokenCount` → `cached_tokens` 抬升（流式+非流式） | 已对齐 | gemini-openai-converter.rs:1106-1157, 1388-1428 | 无字段不注入，避免伪 0（测试 :2236-2249） |
| 4 | `stream_options` 端点门控 | 已对齐 | providers/mod.rs:156-172 | 与 continue #12936 修复方向相同 |
| 5 | DeepSeek 官方判定校验 base_url | 已对齐（文档过时） | llm_manager/mod.rs:3047-3053 | cache-prefix.md:23 指控已修，台账应更新 |
| 6 | DeepSeek Responses 模型列名门控（V3.x 回落 CC） | 已对齐 | llm_manager/mod.rs:3055-3105 | cache-prefix.md:22 指控已修 |
| 7 | `store:false` 无条件下发 Responses | 半对齐 | providers/mod.rs:1578-1580 | DeepSeek 官方豁免（静默忽略）；第三方 Responses 网关残余低概率 400 面 |
| 8 | `prompt_cache_key` 发给所有 Responses 网关 | 半对齐 | model2_pipeline.rs:3181-3187 | 标准参数，但老版严格网关可 400；可考虑与 retention 同口径收窄或加 400 重试剥参 |
| 9 | Responses 工具 `strict:false` 无条件注入 | 半对齐 | providers/mod.rs:1029-1035 | DeepSeek 官方安全；严格第三方 Responses 网关 400 面（vllm #27746 同型） |
| 10 | **system content array + `cache_control` 发 CC 端点** | **缺失（P0 级 400 面）** | model2_pipeline.rs:3662-3667；providers/mod.rs:614-651（清洗缺口） | 官方 DeepSeek V3.x CC 确定性 400；Fireworks/Azure Mistral 类严格网关 400。建议：CC 路径按端点压平 system 为 string 并剥 `cache_control`（保留 Anthropic / OpenRouter / LiteLLM 白名单透传） |
| 11 | OpenAI 缓存保留参数从未下发（死代码） | 缺失 | model2_pipeline.rs:3193-3214 | 两函数零调用点；要么接线（仅官方 OpenAI）要么删除，当前状态最差：注释声称收益、实际不生效 |
| 12 | Gemini 显式缓存（cachedContents / `cachedContent`） | 缺失（可选增强） | 全仓无写入点 | 隐式缓存已覆盖主场景；后台大语料任务可参考 LiteLLM 方案（≥1024 tokens 才建缓存） |
| 13 | DeepSeek Responses 超 1M 上下文 400 不截断 | 缺失（防御缺口） | 发送侧无预算预检 | 官方不做 truncation；长会话应在发送前估算并给出可读错误，而非透传 400 |
| 14 | Gemini Interactions API `total_cached_tokens` | 不适用（记录） | — | 本仓未接 Interactions API；若接入需新增字段解析 |
| 15 | `prompt_cache_miss_tokens` 不读 | 不适用（记录） | — | hit 已够账，miss 可由 prompt - hit 导出 |

---

## 7. 引用（全部 2026-08-26 检索）

1. DeepSeek Context Caching：https://api-docs.deepseek.com/guides/kv_cache
2. DeepSeek Chat Completions API（usage schema、include_usage、末 chunk usage）：https://api-docs.deepseek.com/api/create-chat-completion
3. DeepSeek Responses API 指南（参数兼容表、静默忽略、store:false、1M 400）：https://api-docs.deepseek.com/guides/responses_api/
4. DeepSeek Responses API 参考（usage 字段）：https://api-docs.deepseek.com/api/create-response/
5. DeepSeek V4-Flash Responses/Codex 解读（v4-pro 时间线、静默忽略）：https://apidog.com/blog/deepseek-v4-flash-responses-api-codex/
6. Gemini Context caching（隐式默认开、min tokens、usage_metadata）：https://ai.google.dev/gemini-api/docs/generate-content/caching
7. Gemini Interactions API caching（`usage.total_cached_tokens`）：https://ai.google.dev/gemini-api/docs/interactions/caching
8. Vertex AI context caching 概览（cachedContentTokenCount、90% 折扣、TTL）：https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview
9. Vertex AI caching 博客（隐式 24h 内清、写按标准价）：https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-context-caching
10. Databricks 网关 stream_options 400（opencode）：https://github.com/anomalyco/opencode/issues/31156
11. Databricks 网关 stream_options 400 + api.openai.com 门控修复（continue）：https://github.com/continuedev/continue/issues/12936
12. POE 代理 stream_options 400（cherry-studio）：https://github.com/CherryHQ/cherry-studio/issues/11652
13. 严格供应商 cache_control 400 + 网关剥参实践（pollinations）：https://github.com/pollinations/pollinations/issues/10672
14. vLLM mistral tokenizer `strict` 400：https://github.com/vllm-project/vllm/issues/27746
15. DeepSeek CC content 数组 400（marimo）：https://github.com/marimo-team/marimo/issues/7036
16. DeepSeek CC content 数组 400（vscode-ai-toolkit）：https://github.com/microsoft/vscode-ai-toolkit/issues/264
17. langchain DeepSeek 数组转字符串修复：https://github.com/langchain-ai/langchain/commit/b1c7de98f57bdd304699a05b79acc1953704fc72
18. DeepSeek /anthropic 端点 system 数组 400：https://github.com/deepseek-ai/DeepSeek-V3/issues/1369
19. OpenRouter prompt caching（cache_control ↔ prompt_cache_breakpoint 互译、各家折价表）：https://openrouter.ai/docs/guides/best-practices/prompt-caching 与 https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/
20. LiteLLM prompt caching（usage 归一、Gemini cachedContents 翻译、≥1024 tokens）：https://docs.litellm.ai/docs/completion/prompt_caching 与 https://docs.litellm.ai/docs/tutorials/prompt_caching
