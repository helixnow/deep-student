# R5 #1 — model2 遥测身份分列 + post-adapter 指纹 + P6 retention 裁决

枝 tip 基线：`2d70b400`。改动文件：`src-tauri/src/llm_manager/model2_pipeline.rs`
（独占）+ `llm_usage` 写入路径（types / collector / repo / mod / database）+
新增 migration `V20260826__add_stream_identity.sql`（加法，不改旧 migration）+
`data_governance/migration/llm_usage.rs` 注册表。只写源码与测试源码，未执行
cargo / 测试。

## 结论速览（任务卡三问）

| 问题 | 答案 |
|---|---|
| P6 retention 是删还是接 | **删**。`apply_openai_prompt_cache_retention` 与其门控 `provider_accepts_prompt_cache_retention` 全仓零调用点，纯死实现，且写死 `ttl:"24h"`（被 R5 明令禁止），整体删除。原位置留有硬约束注释：若未来接线，GPT-5.6+ 只允许 `prompt_cache_options:{"ttl":"30m"}`、仅 OpenAI 官方端点、必须附带请求体快照测试。 |
| 身份字段名 | `llm_usage_logs` 三列：`session_id`（既有列，改写真实会话 ID）、`variant_id`（新列）、`run_id`（新列）。落库入口为 `llm_usage::UsageStreamIdentity` + `record_llm_usage_cache_ext_with_identity`。 |
| 指纹分段 | post-adapter 最终请求体（`PreparedProviderRequest::body`）四段：`system` / `tools` / `history` / `current_user`，各取 SHA256 前 16 hex；与同 `session::variant` 作用域上一请求对比，日志记录 `first_divergent_segment`（`baseline` / `none` / 段名）。 |

## 1. 遥测身份：不再把 stream_event 当 session_id

**旧病灶**（原 `model2_pipeline.rs:5745` 附近）：多变体流式路径把整个
run-scoped `stream_event` 传给 `record_llm_usage_cache_ext` 的 `session_id`
参数。事件名形如：

```text
chat_v2_event_{session}_var_{scope}_run_{run}[__stream_generation__{n}]
```

`run` 每次 pipeline 执行都换（见 `tool_loop::build_run_scoped_stream_event`），
于是报表把每次执行当成新会话，跨轮 steady-state 缓存命中率统计彻底失真。

**修复**：

- `model2_pipeline.rs` 新增 `chat_v2_stream_identity(stream_event)`
  解析器（与既有 `chat_v2_session_scope_and_generation` 同口径），还原
  `session_id` / `variant_id`（`_var_`…`_run_` 之间）/ `run_id`（`_run_` 之后）。
  代际后缀 `__stream_generation__N` 只服务流路由，不入库。
- 记录点改调 `record_llm_usage_cache_ext_with_identity`，身份三列分列落库；
  非 `chat_v2_event_` 前缀的事件（review 流等）保留旧行为：事件名整体作为
  `session_id`，variant / run 落 NULL。
- 旧格式兼容：无 `_run_` 后缀的历史事件名只还原 session + variant；
  完全 legacy（无 `_var_`）只还原 session。
- `llm_usage` 模块加法扩展：`UsageRecord.variant_id / run_id` 字段与 builder、
  collector / repo 两条 INSERT 路径、`get_recent_usage_page` 读路径。
  既有 `record_llm_usage_cache_ext` 签名不变（内部委托新函数，variant/run
  为 None），`tool_loop.rs` 等其他调用方零改动。

**Migration**：新文件 `migrations/llm_usage/V20260826__add_stream_identity.sql`
（`ALTER TABLE ... ADD COLUMN variant_id TEXT / run_id TEXT` + 两个部分索引），
不触碰任何旧 migration；`CURRENT_SCHEMA_VERSION` 提到 `20260826`，
`data_governance/migration/llm_usage.rs` 注册 `V20260826_ADD_STREAM_IDENTITY`
并同步注册表测试。NULL 语义 = 未知（历史行 / 非 chat_v2 调用方），报表侧
（#3 的 `scripts/cache-hit-report.py`）按缺列/NULL 降级——该脚本已按本列名
（`variant_id` / `run_id`）实现，两边口径一致。

## 2. CHAT_V2_CACHE_DEBUG 指纹：post-adapter 四段

**旧病灶**：指纹在 pre-adapter 的 `request_body["messages"]` 上取单一
SHA256。Anthropic / Gemini / Responses 适配器转换后的实际发送体与
pre-adapter 形态不同（system 提升为顶层字段、messages→input/contents 等），
指纹与线上缓存前缀脱节；且单一哈希只能回答「变没变」。

**修复**：指纹点移到 `prepare_provider_request` 之后，对 `preq.body`
（真实发送体，与 `log_and_emit_llm_request` 同源）切四段：

1. `system`：顶层 `instructions` / `system` / `systemInstruction` /
   `system_instruction` + 消息列表中 role 为 `system` / `developer` 的条目；
2. `tools`：顶层 `tools`；
3. `history`：消息列表其余全部条目（含工具调用/工具结果）；
4. `current_user`：消息列表**尾部**的 user 消息（本轮输入）。

消息列表兼容 `messages`（OpenAI Chat / Anthropic）、`input`（Responses）、
`contents`（Gemini）。每段 SHA256 取前 16 hex，与同 `session::variant`
作用域（provider 端 prompt cache 的真实存活作用域，跨 run 存续）的上一
请求对比，按前缀顺序 system → tools → history → current-user 找**首个分叉段**：

```text
[PromptCache] post-adapter fingerprint: model=..., scope={session}::{variant},
  system=xxxx, tools=xxxx, history=xxxx, current_user=xxxx,
  first_divergent_segment={baseline|none|system|tools|history|current_user}
```

分叉段之前是缓存命中区，之后全部 miss。指纹存储上限 256 个作用域，超限
整体清空（仅影响下一次基线判定；调试专用路径，不在热路径分配——env 关闭
时零开销）。测试源码覆盖：三种协议形态的切段、四段分叉顺序判定。

## 3. P6 retention：删除死实现

`apply_openai_prompt_cache_retention`（写 `prompt_cache_retention:"24h"` /
`prompt_cache_options:{"ttl":"24h"}`）与门控
`provider_accepts_prompt_cache_retention` 自引入起从未接入任何请求构建路径
（全仓 grep 零调用点）。按任务卡「优先删除」裁决：**整体删除**，不接线。

理由：24h 档按存储计费，多轮会话下成本远超缓存折扣收益，任务卡明令禁止；
30m 接线需要真实计费评估与快照测试配套，本轮不引入新行为。原位置留有
接线硬约束注释（GPT-5.6+ 仅 `ttl:"30m"`、仅官方 OpenAI 端点、必须快照测试），
防止死代码复活成 24h 形态。由于选择删除路线，无新增网络行为，无需快照测试。

## 验证状态

- 仅源码 + 测试源码；按轮规未执行 cargo build / test / clippy。
- 新增测试（只写不跑）：`chat_v2_stream_identity_splits_session_variant_run`、
  `cache_debug_segments_split_openai_chat_body`、
  `cache_debug_segments_split_responses_and_anthropic_bodies`、
  `cache_debug_first_divergent_segment_orders_by_prefix`；
  `data_governance/migration/llm_usage.rs` 注册表测试同步到 8 个迁移 /
  latest 20260826。
- 风险点：`llm_usage` 三处 INSERT 列序手写（collector / repo×2），若列名
  笔误将在编译期（参数计数）与 `repo.rs` 既有 insert/read 测试中暴露。
