# R1 调研：OpenAI Responses / Prompt Caching / Agents SDK 对照本仓

作者：0824 Wave2-A 第 1 轮子代理 #2「调研员-OpenAI」（claude-fable-5-thinking-high）
检索日期：**2026-08-26**。基线 `061b4815`，枝 `cursor/0824-wave2-agent-cache-a875`。
本文档只读代码 + 官方文档调研产物，未改任何产品代码，未跑任何测试。

## 0. 引用来源（全部于 2026-08-26 检索）

| # | 来源 | URL |
| --- | --- | --- |
| S1 | OpenAI 官方 Prompt caching 指南（Responses 视图） | https://developers.openai.com/api/docs/guides/prompt-caching?prompt-cache-api=responses |
| S2 | OpenAI 官方 Prompt caching 指南（.md 原文） | https://developers.openai.com/api/docs/guides/prompt-caching.md |
| S3 | OpenAI 官方 GPT-5.6 Sol 升级指南 | https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md |
| S4 | OpenAI Cookbook「Prompt Caching 201」 | https://developers.openai.com/cookbook/examples/prompt_caching_201 |
| S5 | OpenAI 官方 Running agents（Agents 指南） | https://developers.openai.com/api/docs/guides/agents/running-agents |
| S6 | OpenAI Agents SDK（Python）Running agents | https://openai.github.io/openai-agents-python/running_agents/ |
| S7 | OpenAI Agents SDK（Python）Runner 参考 | https://openai.github.io/openai-agents-python/ref/run/ |
| S8 | openai-agents-python 仓 conversation-state-ownership.md | https://github.com/openai/openai-agents-python/blob/main/.agents/references/conversation-state-ownership.md |
| S9 | AWS Bedrock prompt caching（OpenAI 模型节） | https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html |
| S10 | Azure AI Foundry prompt caching | https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching |
| S11 | OpenAI Cookbook「How to stream completions」 | https://developers.openai.com/cookbook/examples/how_to_stream_completions |
| S12 | Responses streaming events 参考 | https://developers.openai.com/api/reference/resources/responses/streaming-events/ |
| S13 | dreaming.press GPT-5.6 显式断点实测（第三方，佐证限制） | https://dreaming.press/posts/gpt-5-6-prompt-caching-explicit-breakpoints.html |
| S14 | AIHubMix GPT-5.6 缓存计费变化（第三方，佐证费率/保留） | https://aihubmix.com/blog/gpt-5-6-is-live-prompt-caching-billing-changes-explained |

## 1. 官方事实摘要（Prompt caching，GPT-5.6 世代）

1. **断点对象形状**：在 input message 的受支持 content block 内加
   `"prompt_cache_breakpoint": { "mode": "explicit" }`（S1、S2、S9 原文一致）。
   块级参数，不是顶层参数。GPT-5.6 及之后才支持；GPT-5.5 及更早只有 implicit
   缓存，不支持显式断点（S1 模型对比表、S9）。
2. **顶层 `instructions` 打不了断点**：官方原话 "Top-level `instructions` cannot
   contain an explicit breakpoint. To mark reusable developer instructions, place
   them in an `input_text` block inside a developer message."（S1 :88）。
3. **顶层 `prompt_cache_options`**：`{"mode": "implicit"|"explicit", "ttl": "30m"}`。
   - `mode` 默认 `implicit`：官方在最新 eligible message 末尾自动放一个断点，
     **同时仍然采纳你手工放的 explicit 断点**（implicit 断点占用 4 个 cache-write
     槽之一，剩 3 个给 explicit）（S1 :90-94）。
   - `mode:"explicit"`：关闭自动断点，只用手工断点；一个手工断点都没有时该请求
     不参与缓存、不产生 cache write（S1 :82-83、S9）。
   - `ttl`：**唯一支持值 `"30m"`，同时也是默认值**——最近一次写入/复用后至少保留
     30 分钟，可能更久（S1 :313、S2、S13）。**不存在 `"24h"` 取值**。
   - S3 明确：GPT-5.6+ 上旧字段 `prompt_cache_retention` **deprecated**。
4. **旧代模型（GPT-5.5 及更早）retention**：`prompt_cache_retention` 取
   `"in_memory"`（5-10 分钟不活跃、至多 1 小时）或 `"24h"`（延长保留至多 24h，
   KV 张量下放 GPU 本地存储）。`gpt-5.5` / `gpt-5.5-pro` 只支持且默认 `24h`；
   更旧模型未指定时默认取决于组织 ZDR 策略（无 ZDR 默认 24h，有 ZDR 默认
   in_memory）（S2、S4、S10）。
5. **`prompt_cache_key`**：路由亲和参数。GPT-5.6+ 上官方措辞升级为
   "you **must** set `prompt_cache_key` to use the more reliable matching for both
   implicit and explicit caching"（S2）；每个 key+前缀组合约 15 RPM，超量会
   溢出到其他机器造成一次性 miss（S4、S10）。
6. **写入/读取预算与最小长度**：每请求最多 4 个 cache write；读取时回看会话中
   最近 50 个断点取最长匹配前缀；最小可缓存长度 GPT-5.6+ 为 1024 可见 token
   （旧代 2048）（S1 :85-86、:355）。
7. **已知限制（第三方实测，官方未列）**：`function_call_output.output` 内
   input_text 上的断点被 schema 接受、不报 400，但截至 2026-07 GA **静默零
   cache write**（S13）。注意官方 S1 :779-785 的示例反而展示了这种写法——
   以实测为准，规避该位置。
8. **工具与缓存**：官方建议 "Keep tool definitions, ordering, and schemas
   consistent"、临时禁用工具用 `tool_choice:"none"` 而不是删定义、tool search
   `defer_loading:true` 发现的新工具**追加在 context 末尾**以保住已缓存前缀
   （S1 :438-441）。
9. **流式 usage**：Chat Completions 需 `stream_options:{"include_usage":true}`，
   usage 出现在最后一个 `choices:[]` 的额外 chunk（S11）；Responses API 无需
   任何选项，usage 原生随 `response.completed` 事件返回（S12）。缓存命中读
   `usage.input_tokens_details.cached_tokens`（Responses）/
   `usage.prompt_tokens_details.cached_tokens`（CC）（S1、S4）。
10. **非 OpenAI 官方端点也有该参数**：Azure AI Foundry（S10）与 AWS Bedrock
    （S9）均已支持 GPT-5.6 断点与 `prompt_cache_key`；未知第三方兼容网关行为
    不可知。

## 2. 官方 vs 本仓对照表（验收核心）

行号均基于 `061b4815`。`mod.rs` = `src-tauri/src/providers/mod.rs`，
`m2p.rs` = `src-tauri/src/llm_manager/model2_pipeline.rs`。

| 项 | 官方（2026-08-26） | 本仓现状 | 判定 |
| --- | --- | --- | --- |
| P0 断点形状 | 块级 `prompt_cache_breakpoint: {"mode":"explicit"}`（S1/S2/S9） | `mod.rs:1563` 逐字节同形；wire-body 测试 `openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated`（`mod.rs:5091-5169`）固化 | **已对齐** |
| instructions 迁 developer | 顶层 instructions 打不了断点，须放 developer message 的 `input_text`（S1 :88） | `mod.rs:1548-1567` `instructions_as_developer_breakpoint`：能力+端点双门控成立时把 instructions 移入 input 首位 developer 块并打断点；否则保持顶层 instructions（`mod.rs:1582-1584`） | **已对齐** |
| 模型门控 | 显式断点仅 GPT-5.6 及之后（S1/S9） | `model_supports_prompt_cache_breakpoint`（`mod.rs:721-756`）：gpt-5.6+/gpt-6+，只解析完整 GPT 型号段；测试 `model_supports_prompt_cache_breakpoint_parses_gpt_versions`（`mod.rs:5171-5193`）覆盖正反例 | **已对齐** |
| 端点门控 | 参数在 OpenAI 官方、Azure Foundry、AWS Bedrock 均可用；未知网关不可知 | `endpoint_supports_prompt_cache_breakpoint`（`mod.rs:758-760`）→ `is_official_openai_api_endpoint`（`mod.rs:130-135`）仅 `api.openai.com`；第三方网关同模型回落顶层 instructions（测试 :5129-5149 固化） | **半对齐**（保守安全；Azure/Bedrock 场景白丢断点收益，P2 可扩白名单） |
| `prompt_cache_options.mode` | 默认 implicit 且与 explicit 断点共存；explicit-only 可省变化后缀的 cache write（S1） | 适配器**不发送** `prompt_cache_options`：等于 implicit 默认 + 1 个 explicit 断点，功能成立（implicit 占 1 写槽）；但当前 user 尾巴每轮都被 implicit 断点写缓存，多轮场景写费可省 | **半对齐**（可用；explicit-only 为可选优化，注意第 3 条 ttl 陷阱后再上） |
| retention（GPT-5.6+） | `prompt_cache_options.ttl` **仅 `"30m"`**（也是默认）；`prompt_cache_retention` 在 5.6+ deprecated（S1 :313、S3） | `apply_openai_prompt_cache_retention`（`m2p.rs:3205-3214`）对 5.6+ 写 `prompt_cache_options:{"ttl":"24h"}` —— **值非法**（官方无 24h 取值）。且该函数与门控 `provider_accepts_prompt_cache_retention`（`m2p.rs:3193-3196`）**全仓零调用点 = 死代码**（rg 确认仅定义处出现），线上实际从未发送任何 retention 字段 | **缺失 + 死实现带错值**（P1） |
| retention（旧代模型） | `prompt_cache_retention:"24h"` 合法；gpt-5.5/5.5-pro 默认已是 24h（S2/S4/S10） | 死代码 else 分支写 `prompt_cache_retention:"24h"`——值合法但同样从未接线 | **缺失（死实现值正确）** |
| `prompt_cache_key` | GPT-5.6+ 必须设置以启用可靠匹配；≈15 RPM/键（S2/S4/S10） | 活线：`prepare_provider_request`（`m2p.rs:3276-3307`）经 `provider_accepts_prompt_cache_key`（`m2p.rs:3181-3187`，OpenAI Responses/官方 CC 写、DeepSeek 官方不写）注入 `stable_prompt_cache_key`（`m2p.rs:3170-3176`，session_id 或 caller 稳定串，禁随机 UUID，兜底 `deep-student-background`）；Codex 路径 `m2p.rs:3302-3305` 也写；测试 `prompt_cache_key_is_stable_and_never_random`（:1143）、`prompt_cache_key_only_targets_openai_affinity_endpoints`（:1157） | **已对齐** |
| 断点位置雷区 | `function_call_output` 上的断点静默零写入（S13） | 本仓只在 developer 首块打 1 个断点，不触及工具输出块 | **已对齐（天然规避）** |
| 4 写槽 / 50 断点回看 / 1024 最小长度 | S1 :85-86、:355 | 本仓单断点方案远低于 4 槽预算；无 50 断点/最小长度相关逻辑（无需客户端处理，仅计费观测意识） | **已对齐（无需动作）** |
| CC 流式 usage | `stream_options.include_usage=true`，usage 在末尾 `choices:[]` chunk（S11） | `OpenAIAdapter::build_request`（`mod.rs:156-172`）仅官方端点 + 未显式设置时注入；测试 `openai_adapter_gates_stream_options_include_usage_by_endpoint`（`mod.rs:6118`）与调用方显式 false 保留（:6159-6166） | **已对齐** |
| CC 流终止状态机 | usage chunk 在 finish_reason 之后、`[DONE]` 之前（S11） | `saw_finish_reason`（`mod.rs:80-83`）：finish_reason 只记标记不终止，等 `[DONE]`/EOF（`mod.rs:198-220, 305-322`），避免 usage chunk 被截断 | **已对齐** |
| Responses 流式 usage | usage 原生在 `response.completed`，无需 stream_options（S12） | Responses 适配器不注入 stream_options；usage 解析 `input_tokens_details.cached_tokens`（`mod.rs:3407-3412`）五源取 max（`mod.rs:3421-3430`），`cache_write_tokens`（:3434-3454）、reasoning_tokens 三源（:3457-3469）均覆盖 | **已对齐** |
| `store` 默认 | 服务端默认 store:true 保存 30 天 | `mod.rs:1578-1580` 默认 `store:false`（隐私优先，DESIGN 原则 5） | **已对齐（本仓刻意更严）** |

### P0 结论（任务卡指定核实项）

- **断点形状**：官方就是 `{"mode":"explicit"}` 块级对象，本仓 `mod.rs:1563` 与
  wire 测试**完全对齐**，无需改动。
- **端点门控**：本仓 fail-closed 到 `api.openai.com` 单域名，比官方支持面
  （含 Azure/Bedrock）窄，属于安全的半对齐，不是缺陷；扩面是 P2 选做。
- **retention 死实现**：本仓**有对应实现但是死代码**（两个函数零调用点），
  且 GPT-5.6+ 分支的 `ttl:"24h"` 与官方唯一合法值 `"30m"` 冲突——**接线前必须
  改值**，否则在官方端点上大概率 400/参数拒绝。旧代分支 `"24h"` 合法。
  另注意：官方 `ttl:"30m"` 就是默认值，5.6+ 分支其实可以整个删掉（不发
  `prompt_cache_options` 效果等同）；真正有增益的只有旧代模型的
  `prompt_cache_retention:"24h"`（而 gpt-5.5/5.5-pro 默认已 24h，收益集中在
  gpt-5.4 及更早 + 无 ZDR 组织）。

## 3. Agents SDK 工具环 vs 本仓 `tool_loop`

官方循环（S5/S6/S7）：调模型 → 归类输出：final output 终止 / handoff 换
agent 重入 / tool calls 执行后 append 结果重入；超 `max_turns` 抛
`MaxTurnsExceeded`。状态回放四策略互斥（S6/S8）：`to_input_list()` 客户端全量
重放、`session`（SDK+自备存储）、`conversation_id`（Conversations API 服务端）、
`previous_response_id`（Responses 最轻服务端续链，传 `result.last_response_id`
+ 仅新一轮输入）；session 与服务端续链禁止混用（S8
`validate_session_conversation_settings`）。

本仓 `src-tauri/src/chat_v2/pipeline/tool_loop.rs`（5125 行，概览）：
`execute_with_tools`（:304）单 future `loop`（:342，弃自递归防栈爆），每轮
`before_turn` hooks（:345-347）→ doom-loop 终止检查（:354-383）→ 轮次上限
（可配置默认 30、绝对 150、心跳白名单 ≤50 次绕过，:385-457）→ 环内
compaction（`before_compaction` hooks + 历史重载重编译，:465-503）→ LLM 调用
→ 工具执行（`before_tool` 准入 `ToolGateOutcome` :3191、`after_tool` 审计
:3272）。缓存前缀纪律：tools 名字序会话级 append-only 冻结
（`freeze_tool_schema_order_for_prompt_cache` :39-72、会话基线载入 :330-331、
基线合并 :78-87）+ schema 字节窗口级冻结
（`freeze_tool_schemas_for_prompt_cache` :105+，窗口 = 一次 execute_with_tools）
+ 技能注入首轮冻结、环内新技能按 tool_call_id 锚定到 tool result 之后（:324、
:667）。

**最关键的 3 点异同**：

1. **状态回放**：SDK 提供服务端续链（`previous_response_id` /
   `conversation_id`）作为一等选项；本仓刻意只做客户端全量重放
   （`store:false` 默认，`mod.rs:1578-1580`；DESIGN P2「不把
   store:true+previous_response_id 当默认优化，Codex 官方靠全量重放+稳定
   key」）。等价于 SDK 的 `to_input_list()`/`session` 客户端族，隐私更严；
   代价是每轮全量传输，靠 prompt cache（断点+prompt_cache_key）而非服务端
   状态换性能——与官方 Codex 实践同路线，方向正确。
2. **终止与防失控**：SDK 只有 `max_turns` 硬上限（超限抛异常）+ final output
   类型判定；本仓是多层软硬结合——可配置轮上限、绝对上限 150、心跳白名单
   绕过、doom-loop 同名同参指纹 5 连击终止（tool_loop.rs:354-383），且超限
   不抛错而是落 `tool_limit` 块引导用户「继续」。本仓严格更强，SDK 无
   doom-loop 等价物。
3. **缓存前缀治理**：SDK 的 handoff 会切换 agent/instructions（前缀断裂，SDK
   不做任何缓存前缀保护）；本仓无 handoff，但把官方缓存文档的工具纪律
   （"keep tool definitions/ordering/schemas consistent"、新工具 append 到
   末尾，S1 :438-441）实现成了机制而非约定：名字序会话级冻结 + 字节级窗口
   冻结 + 技能注入锚定。本仓 hooks（before_turn/before_tool/after_tool/
   before_compaction）形似 SDK 的 lifecycle hooks/guardrails，但 before_tool
   的准入拦截（ToolGateOutcome + TOCTOU 三段）比 SDK 的 approvals 语义更重。

## 4. 差距清单（按优先级，供后续轮次）

| 级 | 差距 | 落点 | 建议 |
| --- | --- | --- | --- |
| P1 | retention 死实现未接线，且 5.6+ 分支 `ttl:"24h"` 值非法（官方仅 `"30m"`） | `m2p.rs:3193-3214`（零调用点） | 二选一：(a) 删 5.6+ 分支（默认即 30m），仅对旧代模型接线 `prompt_cache_retention:"24h"`，在 `prepare_provider_request` 中经 `provider_accepts_prompt_cache_retention` 门控后调用；(b) 整体删除死代码。禁止带着 `ttl:"24h"` 接线 |
| P2 | 断点端点门控仅 `api.openai.com`，Azure Foundry / AWS Bedrock 已官方支持 | `mod.rs:130-135, 758-760` | 评估把 Azure（`*.openai.azure.com` / Foundry v1）与 Bedrock 网关纳入 `endpoint_supports_prompt_cache_breakpoint` 白名单；保持未知网关 fail-closed |
| P2 | 未发送 `prompt_cache_options.mode:"explicit"`，implicit 断点每轮对易变尾巴产生 cache write 费 | `mod.rs:1572-1580` | 若测得写费显著，评估 explicit-only + 多断点（≤4 写槽，如 developer 块 + 最近稳定历史尾）；官方 S3 告诫「不要全局改 explicit」，需按工作负载实测 |
| P3 | 无 50 断点回看/1024 最小长度的观测提示 | telemetry | 在 usage 观测面补 `cached_tokens=0` 且前缀 <1024 token 的诊断标注（仅观测，不改请求） |
| 备注 | `function_call_output` 断点零写入陷阱（S13） | 现状未触雷 | 未来若做多断点方案，明确禁放工具输出块 |

## 5. 与既有文档的一致性说明

- `docs/dev/sota-conversation-core/DESIGN.md` P2 节「GPT-5.6+ 稳定指令改放
  developer input_text 并打 prompt_cache_breakpoint（顶层 instructions 打不了
  断点）；评估 prompt_cache_options」——与官方 S1 :88 完全吻合，且前半已落地
  （`mod.rs:1548-1567`），「评估 prompt_cache_options」即本文 P1/P2 两条。
- `docs/dev/sota-conversation-core/ROUND-01-responses-adapter.md` 列的多
  reasoning item 回放、encrypted reasoning 非工具轮不回放等缺陷与缓存无直接
  关系，本文不重复；其「usage / prompt_cache_key / previous_response_id 与
  DESIGN 重复」的口径经本轮独立核实仍然成立。
- `docs/0824-MERGE-PLAN.md` Step 22：provider 修复 `35706d09 → 55846040` 已
  落（能力门控与流完成），本文对照表中「已对齐」各项即其结果的独立复核；
  该步为零测试执行落地，测试仅为源码存在（与本轮铁律一致）。
