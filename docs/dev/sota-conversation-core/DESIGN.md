# 优化方案（草案，第一轮后）

本文件在多轮调研收敛前保持草案。落地必须以子代理交叉验证后的证据为准。

## 原则

1. **协议按语义使用，而不是只做字段改名。**
   Chat Completions 仍是内部规范可以，但 Responses 出口要保留
   `previous_response_id`、output items、hosted tools、usage 细节。
2. **前缀只往后追加，不改已经发出去的头部。**
   tools / instructions 稳定段 / cache key 在会话内冻结。
3. **易变事实离开稳定前缀。**
   日期、检索、待办、刚更新的画像、技能正文，放到 user 尾部或独立 cache breakpoint。
4. **测量必须能看见命中。**
   每种协议的 cached tokens 字段都要解析；报告按协议/供应商拆分。
5. **禁止静默破坏隐私默认。**
   `store` 默认保持 false；链式 Responses 必须是用户/会话显式选择。

## 候选工作包（实现阶段再拆 PR）

### P0 观测与 cache key（按供应商分流）

- **所有 Responses 路径**：解析 `usage.input_tokens_details.cached_tokens`
  （以及 `output_tokens_details.reasoning_tokens`）。CC 路径继续读
  `prompt_tokens_details` / `prompt_cache_hit_tokens`。
- **OpenAI / Codex**：稳定 `prompt_cache_key` = 会话 id；禁止 `Uuid::new_v4()` 回落。
- **DeepSeek**：不要写 `prompt_cache_key` / `previous_response_id` / `store:true`
  （官方明确不支持，静默忽略）。唯一杠杆是前缀字节稳定。
- **DeepSeek 默认协议也要跑模型门控**：`api_protocol=None` 不得只靠注册表把未支持型号
  送进 Responses；`is_official_deepseek_config` 必须核对 base_url。
- **按 2026-08-23 官方文档放开 `deepseek-v4-pro`（及 vision-exp）的 Responses**，同步
  `effective_api_protocol_for_config`、前端 modelConverters、registry 备注与回归测试。
  v3 等未列名型号继续回落 CC。
- `cache-hit-report.py` 增加 protocol / provider / token_source 维度；cached 全 NULL 显示「无测量」而不是 0%。
- 真正实现 `V20260806`：写入并回放 `llm_content` / `tool_call_id` / `round_text`。
- reasoning item 按响应顺序收集 `Vec`，与相邻 `function_call` 配对回放；禁止单值覆盖 + 绑死第一个 tool id。
- 非工具轮也回放上一 assistant 的 encrypted reasoning item。
- Anthropic：`build_merged_usage_event` 字段级合并，保留 `message_start` 的 cache 字段；非流式转换不得丢 cache。
- Gemini 流式把 `cachedContentTokenCount` 抬到顶层 `cached_tokens`。
- `record_llm_usage` 真实写入 `token_source` 与 adapter/协议；OpenAI CC 补 `stream_options.include_usage`。

### P1 前缀冻结（优先级：回放一致 → 迁出 system → Anthropic 断点 → 目录/tools）

- **用户消息发送/回放字节一致**：落库或确定性重建与 live 相同的
  `<user_query>` + `<injected_context>`（含该轮 runtime_facts）。这是 agentic 场景收益最大的单点。
  同步：检索脱敏视图、`thought_signature`、空 `reasoning_content` 边界、Responses reasoning item
  都必须按 live 字节重放；有无瞬态技能不得改变连续 user 合并规则。
- turn-volatile 整段迁出 system：format_guide、按 query 重排的 user_profile、todos、
  citation/context、canvas → 当前 user 的 `<injected_context>`。system 只留 latex /
  instructions / AGENTS / user_preferences + **固定**引用规则。
- `<available_skills>` 改 `excludeLoaded=false`，或整块移出 system；已加载状态用 tool result 表达。
- 技能正文首次加载后位置冻结（或随 tool result 驻留）；环内新技能插到工具结果之后，不要插到当前 user 之前。
- tools 会话内冻结；新工具延迟到下一稳定窗口。排序键必须取 `function.name`（回退顶层 `name`），
  现状 G6 是空操作。统一写 `custom_tools`（多变体现在写的 `"tools"` 是死键）。
  稳定后改为「首见轮次 + 名字」append-only。
- `web_search` engine enum 不要写进 schema。
- Anthropic：**保留顶层 automatic `cache_control`**（ROUND-02 冻结结论 P2 第 11 条：
  「auto + tools/system 尾保险断点」，见 [ROUND-02-synthesis.md](./ROUND-02-synthesis.md)）；
  system 用 block 数组，在 tools 尾与稳定段末尾补两个显式 ephemeral
  保险断点（≤4，不拆 auto，不剥调用方块级标记）。
- DeepSeek 默认协议路径也要跑模型门控；`is_official_deepseek_config` 校验 base_url。
- user_profile 停止按当前 query 重排；microcompact 只在 compaction 事件批量推进。
- `prompt_builder` 跨轮前缀快照测试。
- 历史重放按 `active_variant_id` 对应 `block_ids` 过滤，禁止把多变体正文 join 在一起。
- `workspace_injection` 块按 live 形态还原为 user 消息。
- 分支复制带上 replay 三列；OpenAI `prompt_cache_key` 可沿用源 session。
- compaction 阈值必须先于 FIFO 头删触发。

### P2 协议增强（跟 Codex 无状态，不跟 OpenCode 链式）

- **不把 `store:true` + `previous_response_id` 当默认优化。** Codex 官方靠全量重放 + 稳定 key。
  链式仅作远期可选。
- DeepSeek：完整 `web_search_call` 写入历史并原样回传 `input`。
- Anthropic：保留顶层 automatic；只补 tools 尾 + system 尾两个显式保险断点（不要拆掉 auto）。
- GPT-5.6+：稳定指令改放 developer `input_text` 并打 `prompt_cache_breakpoint`
  （顶层 `instructions` 打不了断点）；评估 `prompt_cache_options`。
- Codex 非聊天调用面禁止随机 cache key，改 caller 级稳定串。

### P3 DeepSeek / OpenAI hosted 能力

- 保持 DeepSeek `web_search` 门控（仅官方 + flash 系列）。
- 评估 OpenAI hosted web_search / file_search 是否应对齐，而不是永远走本地 function。
- 主适配器补 `output_item.added` 与 `function_call_arguments.delta`（对齐 Codex SSE 桥）。
- 修 `web_search_call.in_progress` 阶段误标；透传 `top_p`。
- 不把 SiliconFlow 等无 Responses 端点的托管模型切过去。

## 测试要求

- 单元：usage 字段矩阵、cache key 稳定性、tools 快照冻结、prompt 分段稳定性。
- 回放：同一会话连续两轮的 instructions+tools 字节相等（除允许的动态后缀）。
- 回归：DeepSeek 非 flash / 第三方托管不得误走 Responses。
- 不引入真实密钥的联调；用夹具模拟 Responses SSE 与 usage。
