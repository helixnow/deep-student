# 第一轮调研：父代理预审

模型约定：本轮父代理直改仅限文档。代码审阅结论如下，待 Fable 子代理交叉验证后写入 DESIGN。

## 1. Responses 适配器：兼容层为主，局部原生

主实现：`src-tauri/src/providers/mod.rs` 的 `OpenAIResponsesAdapter`。

### 已具备的原生/半原生能力

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| CC messages → Responses `input` / `instructions` | 完整转换 | `convert_to_responses_format_for_endpoint` ~1109 |
| function 工具扁平化，透传 hosted `type` | 有 | `convert_tool_definition_to_responses` ~807；非 function 原样透传 |
| `strict` 缺省显式 false | 有，避免 Responses 默认自动 strict | ~828 |
| `store` 默认 false | 有，桌面隐私优先 | ~1200 |
| GPT-5 / o / codex `include=["reasoning.encrypted_content"]` | 有 | ~1236 |
| reasoning item 回放到 input | 有 | assistant 消息上的 `response_reasoning_item` ~1156 |
| `web_search_call` 流式事件去重 | 有 | `emit_web_search_item` ~1008 |
| DeepSeek 官方 hosted `web_search` | 有，替换本地 function | `model2_pipeline.rs` `server_side_web_search_enabled` ~387 |
| Codex OAuth 专属 Responses + `prompt_cache_key` | 有，但有坑 | `prepare_provider_request` ~2267 |
| 流式必须等协议终端事件 | 有 | `requires_explicit_stream_completion` |
| DeepSeek 等端点保留 `thinking` 扩展字段 | 有 | `preserves_provider_reasoning_extensions` ~596 |

### 明显的兼容层特征 / 缺口

1. **没有 `previous_response_id`。** 每轮把完整历史再转换成 `input`。
   这是 Responses 最核心的多轮原语。`store:false` 使服务端链不可用，属于有意识的隐私取舍，
   但应在可选「允许服务端留存」时打开链式调用，而不是永远全量重放。
2. **`prompt_cache_key` 只给 Codex。** OpenAI API key 与 DeepSeek Responses 走自动前缀缓存，
   没有会话级显式 key。官方文档里该字段用于把同一会话的请求路由到同一缓存分片。
3. **Codex session_id 回落 `Uuid::new_v4()`。** 空 session 时 cache key 每请求变化，
   等于主动破坏缓存。
4. **没有 `prompt_cache_retention` / background / 多数 hosted tools**
   （`file_search`、`code_interpreter`、`computer`、hosted MCP）。
5. **流式解析把 Responses 事件再压回 Chat Completions 形状的 `ToolCall`。**
   对上层友好，但丢失 item 身份、`id` vs `call_id`、reasoning 加密块的一等公民地位。
6. **DeepSeek 原生利用目前主要是 `web_search` + thinking 透传 + 模型门控。**
   协议主体仍是同一套 CC→Responses 转换器。

初步结论：**不是「只做了 404 级兼容」；也还不是「按 Responses 语义建模的原生客户端」。**
更接近「高质量的传输转换器 + 少量供应商特例」。

### 官方能力对照（2026-08 公开文档，父代理已核对）

**OpenAI Responses**

- 多轮原语是 `previous_response_id` / `conversation`，可与全量 `input` 二选一。
- `prompt_cache_key` 是路由提示：把共享长前缀的请求打到同一缓存分片。
- 命中读 `usage.input_tokens_details.cached_tokens`（CC 才是 `prompt_tokens_details`）。
- GPT-5.6+ 改为「断点处精确匹配」，默认隐式断点在最新 user/tool 消息；不再自动回退到最长未标记前缀。
- `store` 默认在官方服务端为 true；我们显式改成 false。

**DeepSeek Responses**（`api-docs.deepseek.com/guides/responses_api`）

- **无状态**：`previous_response_id` / `conversation` / `store` / `prompt_cache_key` **均不支持**。
  给 DeepSeek 加 cache key 或链式 id 会被静默忽略，不是优化项。
- 缓存是磁盘前缀自动命中；V4 的 prefix unit 在「本轮 user 结束」和「assistant 结束」两个边界落盘，
  后续请求必须完整复用某个 unit，中间改一个字节就会整段 miss。
- 原生工具只吃 `function` + `web_search`；`web_search_call` 必须原样回传，服务端自己恢复搜索结果。
  我们目前只把搜索结果抽成 UI 来源，**不把 `web_search_call` item 写回下一轮 `input`**。
  reasoning item 有回放通道，hosted search 没有。
- Responses usage 的缓存字段是 `input_tokens_details.cached_tokens`（不是 CC 的 `prompt_cache_hit_tokens`）。
- `include` / `encrypted_content` / hosted file_search 等不支持。

因此：**对 DeepSeek，SOTA 等于「字节级前缀稳定 + hosted web_search 回传 + Responses usage 解析」。**
对 OpenAI，才谈得上 `previous_response_id` 与 `prompt_cache_key`。

## 2. 缓存命中：设计有意识，测量和前缀仍有断裂点

### 已做对的地方

- `prompt_builder.rs` 明确分成「稳定前缀」与「动态后缀」。
  LaTeX 规则、`system_instructions`、AGENTS.md、`user_preferences` 在前。
  RAG / citation / canvas 在后，避免「有无检索」打碎稳定前缀。
- 技能不进 system，而是 `transient` user 消息，插在 `base_history_len`
  （历史之后、本轮用户消息之前）。历史前缀可保持。
- `V20260806__prompt_cache_replay_consistency.sql` 持久化 `llm_content` /
  `tool_call_id` / `round_text`，避免重放时 tool id 从 `tc_{block_id}` 重新派生
  导致整段后续前缀失效。
- `runtime_facts` 进 **当前用户消息** 而不是 system。默认只写日期，时间敏感才写到秒。
- usage 提取已覆盖 Anthropic `cache_read_input_tokens`、DeepSeek
  `prompt_cache_hit_tokens`、OpenAI CC `prompt_tokens_details.cached_tokens`。
- `scripts/cache-hit-report.py` 按 caller / session 冷启动 vs 稳态 / 模型聚合。

### 会切断或缩短前缀的点

| 场景 | 位置 | 为何断裂 | 严重度 |
| --- | --- | --- | --- |
| 中途加载技能导致 tools 数组变化 | 工具面 + 技能 embedded tools | 各厂商把 tools 算进请求头部门前缀 | 高 |
| `learner_profile` / `active_todos` 在 instructions 内且可能被工具改写 | `prompt_builder.rs` 610–636 | 改写后 instructions 后半失效；若画像很长，浪费大 | 中高 |
| `user_message_format_guide` 随 hints 出现/消失 | `prompt_builder.rs` 594–608 | 插在稳定前缀之后、画像之前，画像段无法跨「首次带引用」命中 | 中 |
| 每日 `runtime_facts` 日期变化 | `context.rs` 1165 | 只影响**当前** user 消息则无妨；若历史被重编译则断整段对话前缀 | 中（取决于重放路径） |
| 历史附件按「当前模型能力」重编译 | `history.rs` 549 | 换模型或能力门控变化会改旧 user 字节 | 中 |
| 变体分支 skill snapshot 不同 | `multi_variant.rs` 831 | 同 session 不同前缀 | 中 |
| `prompt_cache_key` 缺失或随机 | 仅 OpenAI / Codex | 路由不到同一缓存分片，或永远 miss | 高（OpenAI）；DeepSeek 官方忽略该字段 |
| Responses cached_tokens 漏解析 | `extract_usage_tokens` / `llm_adapter.rs` / `providers/mod.rs` `build_usage_event` | 三处都只读 `prompt_tokens_details.cached_tokens`，不读 Responses 的 `input_tokens_details.cached_tokens`。OpenAI 与 DeepSeek Responses 命中会被系统性记成 0 | 高（观测） |
| `V20260806` 列未落地 | 迁移有 `llm_content` / `tool_call_id` / `round_text`；`repo.rs` INSERT 与 `persistence.rs` 均未写这些列 | 注释声称「targeted UPDATE 保证重放字节一致」，实现是空的。跨日 `runtime_facts`、历史重编译、合成 `tc_{block_id}` 仍可能发生 | 高 |

### 不同协议的命中条件（预审）

- **OpenAI 自动前缀缓存**：从请求第一个字节起必须一致。tools、instructions、
  input 历史都算。`prompt_cache_key` 只是分片路由提示。GPT-5.6+ 在断点处精确匹配。
- **DeepSeek 磁盘前缀缓存**：无 cache key。V4 prefix unit 落在本轮 user / assistant
  边界；后续必须完整复用某个 unit。`prompt_cache_key` / `previous_response_id` 无效。
- **Anthropic `cache_control`**：最多 4 个 breakpoint；system + tools 必须稳定且在前。
  `model2_pipeline.rs` ~2628 有 ephemeral 标记，需确认是否只打在 system 文本、
  工具变化时是否失效。
- **OpenAI `store` + `previous_response_id`**：服务端状态链。当前默认 `store:false`。
  DeepSeek 不支持此路径。

## 3. 技能与系统提示：比「全塞进 system」好，仍不是 SOTA

技能注入（`pipeline/helpers.rs`）：

- 按 pinned / mode bundle / agentic session / branch-local 分层，id 排序后注入。
- 预算不足会 **丢弃** 后部技能（`dropped_skill_ids`）。丢弃集合若随上下文膨胀变化，
  本轮 skill 消息集合不稳定。
- `ReplaySkillPayloadSnapshot.without_skill_contents` 避免把技能正文写入持久化，
  重放依赖运行时再取正文。若磁盘上的技能文件变了，重放字节会变，缓存断。

系统提示：

- 默认 **不** 注入 `<system_time>`（测试锁定）。
- 学习者画像每次从 DB 现场加载（`load_learner_profile_block`），对话中
  `learner_profile_update` 会改变下一轮 instructions。

## 4. 与行业方向的预期差距（待第二轮公开资料交叉）

父代理预审预期（不是最终对标结论）：

| 做法 | 预期 SOTA | 我们 |
| --- | --- | --- |
| 多轮状态 | Responses `previous_response_id` 或等价 item 引用 | 全量 CC 历史重放 |
| 缓存键 | 稳定 session/thread cache key | 仅 Codex，且可能随机 |
| 系统提示 | 静态宪法在前，易变事实在 user / 独立 cache breakpoint | 已分层，但画像/待办仍在 instructions |
| 技能 | 按需、在对话尾部、不改 tools 直到稳定集合 | 尾部注入是对的；tools 动态仍危险 |
| 观测 | 按协议解析 cached tokens + 前缀指纹 | Responses 字段可能漏掉 |

## 5. 下一轮要向子代理追问的问题

1. `input_tokens_details` 是否在任何路径被读取？
2. Anthropic `cache_control` 打在哪几段？工具是否分开打点？
3. DeepSeek Responses 官方是否支持 `prompt_cache_key` / hosted tools 除 web_search 以外的类型？
4. OpenCode / Claude Code / Codex / Pi 如何保证 tools 集合在会话内冻结？
5. `llm_content` 是否覆盖 runtime_facts，从而避免跨日重编译？
6. 若打开 `store:true`，桌面隐私与链式 Responses 如何做成可配置而不是硬编码？
