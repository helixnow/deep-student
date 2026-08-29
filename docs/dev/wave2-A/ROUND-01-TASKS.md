# Wave2-A 第 1 轮任务卡（锚定 + 调研 + P8 低风险落地）

基线：`origin/cursor/0824-cde6` @ `061b4815`（Step 23）。
本枝：`cursor/0824-wave2-agent-cache-a875`。Draft PR：#345。
模型：**全部子代理 `claude-fable-5-thinking-high`**。禁止 sol / GPT / xhigh。
禁止：任何 npm / cargo / tsc / vite / CI / 测试执行 / computerUse。
允许：读代码、改产品代码（仅 #6）、写文档与测试源码（不跑）、grep、web search。

`docs/0824-quality-review/*` **不在 tip 061b4815**（目录不存在）。本轮必读改用：

- `docs/0824-MERGE-PLAN.md` Step 22（provider `55846040` 已落、零测试验证）
- `docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md`
- `docs/dev/sota-conversation-core/ROUND-01-pipeline.md`
- `docs/dev/sota-conversation-core/ROUND-01-responses-adapter.md`
- `docs/dev/sota-conversation-core/ROUND-01-tools.md`
- `docs/dev/sota-conversation-core/ROUND-01-telemetry.md`
- `docs/dev/0824-g-chat.md`、`docs/dev/0824-g-invariants.md`

## 红线 / 禁改区

- 不碰 `src-tauri/src/data_governance/migration/coordinator.rs`（归 D）
- Composer 移动热区归 C、桌面行为归 B；本会话只碰缓存/技能快照相关段
- `chatanki_executor` / `qbank_executor` / `GenerativeUiExecutor` 只读不改
- hooks 十五段准入序列 + 三段式 TOCTOU 语义不许动
- `ApprovalGateHook` 必须保持 `default_pipeline_hooks()` 首位 + `TaskAuditHook`
- 过滤器负例测试一条不许删
- 不修 issue #122（只允许定位探针，本轮调研员不要声称已修）
- 不 merge 任何其他枝；只在本枝原创提交
- 同文件同轮单人：#6 独占 `hooks.rs`；其余只读该文件

## 产出目录

每人只写自己的指定文件，不要改别人的产出。

---

### #1 调研员-Anthropic缓存

**产出**：`docs/dev/wave2-A/r1-anthropic-cache.md`

**文件清单（读）**：

- `src-tauri/src/providers/mod.rs`（Anthropic 转换 / cache_control / 四槽 / 工具 marker，约 :2337-2489, :2795-2930, :3178-3276）
- `src-tauri/src/llm_manager/model2_pipeline.rs` 中 cache_control 打点
- `docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md`

**验收**：对照官方 Anthropic prompt caching（cache_control / TTL 5m+1h / 自动+显式 / 4 槽预算 / 最小 token / 断点放在稳定前缀尾）。产出差距清单：已对齐 / 半对齐 / 缺失，每条带本仓行号。Web search 官方文档，写引用 URL 与检索日期 2026-08-26。

---

### #2 调研员-OpenAI

**产出**：`docs/dev/wave2-A/r1-openai-cache.md`

**文件清单（读）**：

- `src-tauri/src/providers/mod.rs`（Responses / `prompt_cache_breakpoint` / `include_usage` / `stream_options` / retention，约 :156-170, :721-758, :1549-1582, :5091+）
- `docs/dev/sota-conversation-core/ROUND-01-responses-adapter.md`
- `docs/dev/sota-conversation-core/DESIGN.md`

**验收**：官方 Responses API + prompt caching（breakpoint 对象形状 `{"mode":"explicit"}`、retention、Agents SDK 工具循环与状态回放）对照本仓。列出官方形状 vs 本仓形状、端点门控、Agents SDK 工具环 vs 本仓 `tool_loop`。URL + 日期。

---

### #3 调研员-DeepSeek/Gemini

**产出**：`docs/dev/wave2-A/r1-deepseek-gemini.md`

**文件清单（读）**：

- `src-tauri/src/providers/mod.rs` DeepSeek / Gemini 路径
- `src-tauri/src/llm_manager/provider_quirks.rs`
- `docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md` DeepSeek 节
- `docs/dev/0824-rel-llmusage.md`（若存在）

**验收**：context caching、usage 字段（`prompt_cache_hit_tokens` / `cached_tokens` 等）、兼容网关对 `stream_options` / `store` / `cache_control` 的 400 面。本仓差距清单。URL + 日期。

---

### #4 调研员-Agent框架

**产出**：`docs/dev/wave2-A/r1-agent-frameworks.md`

**文件清单（读）**：

- `src-tauri/src/chat_v2/pipeline/hooks.rs`（只读）
- `src-tauri/src/chat_v2/pipeline/tool_loop.rs`（只读）
- `src-tauri/src/chat_v2/pipeline/multi_variant.rs`（只读）
- `src-tauri/src/chat_v2/tools/skills_executor.rs`（只读）
- `docs/dev/chat-v2-subagent-runtime.md`
- `docs/dev/sota-conversation-core/ROUND-01-opencode-pi.md`
- `docs/dev/sota-conversation-core/ROUND-01-codex-claude.md`

**验收**：Claude Code / 开源 agent 框架的子代理派发、prompt 前缀治理、compaction 实践。对照本仓给出「契合 / 不契合 / 改造建议」矩阵（至少 8 行）。Web search。**不要改产品代码。**

---

### #5 锚定员-tool_loop

**产出**：`docs/dev/wave2-A/r1-tool-loop-anchor.md`

**文件清单（读）**：`src-tauri/src/chat_v2/pipeline/tool_loop.rs`（5125 行，全量读）
相关测试：`prefix_snapshot_tests.rs`、`parallel_exec_tests.rs`、tool_loop 内 `#[cfg(test)]`

**验收**：冻结原语调用点表（`freeze_tool_schemas` / `sort_tool_schemas_for_prompt_cache` / frozen order / prefix snapshot）；hooks 调用点（before_turn / before_tool / after_tool / before_compaction）；TOCTOU 三段检查位置；测试清单（名字+断言意图）。标出 P3 schema 只冻单轮 / 多变体只冻名字序的现状行号。**不改产品代码。**

---

### #6 锚定员-hooks（独占 hooks.rs，本轮唯一产品改动）

**产出代码**：`src-tauri/src/chat_v2/pipeline/hooks.rs`
**产出文档**：`docs/dev/wave2-A/r1-hooks-p8.md`

**P8 四小件（必须落地）**：

1. **删只写字段**：`ToolAdmission.approval_arguments` 只在 `:57` 初始化、`:937` 回写，全仓无读点。删除该字段及两处写入。**不要删** `ApprovalGateHook` 方法内的局部变量 `approval_arguments`（仍用于准入逻辑）。
2. **依赖断言**：`TaskAuditHook.after_tool`（`:984-1035`）隐式依赖 `ApprovalGateHook` 填的 `authority_admission` / `is_external_mcp` / `trusted_automation_preauthorized`。在文件头 + trait/`default_pipeline_hooks` 文档化；在现有 `default_hooks_keep_approval_gate_first` 旁加断言或注释强化「审计消费准入产出」。不要改审计语义。
3. **trait 失败语义**：写明 `before_turn` 可 `Err` 中断回合；`before_tool` 用 `ToolGateOutcome` 拦截；`after_tool` / `before_compaction` 不可失败（默认空实现、无 Result）。
4. **泛型等待器**：`:1231-1237` 与 `:1380-1386` 两段同构 `tokio::select!`（timeout + cancel）收敛为一个小泛型/函数，两处调用它。等待后的错误处理分支保持原样。

**禁改**：十五段准入序列顺序与条件、TOCTOU 三段、`ApprovalGateHook` 在 default 链首位、catastrophe / fail-closed 测试语义。

**验收**：`rg approval_arguments` 在 `ToolAdmission` 上为零字段；两处 select 收敛；测试 `default_hooks_keep_approval_gate_first` 仍在；文档说清切点失败语义。只写不跑测试。

---

### #7 锚定员-multi_variant

**产出**：`docs/dev/wave2-A/r1-multi-variant-design.md`

**文件清单（读）**：

- `src-tauri/src/chat_v2/pipeline/helpers.rs:928-1081`（append-only 合并）
- `src-tauri/src/chat_v2/pipeline/multi_variant.rs:498-544, 1270-1325, 1600-1689`
- 其余 multi_variant / helpers 中与 prefix / frozen order / history merge 相关段

**验收**：写清 P1「[A,X] vs [A,Y] 分叉」为何 append-only 救不了。设计稿必须 **二选一并论证**：

- 方案 A：fan-out 统一代际（所有变体共享同一 prefix generation，分叉后整扇出切代）
- 方案 B：variant 级基线（每变体独立 generation，重放按 variant 恢复）

给出推荐方案、数据键、锁/事务边界、对缓存命中的影响、第 2 轮落地步骤。**本轮不改产品代码。**

---

### #8 锚定员-prompt链

**产出**：`docs/dev/wave2-A/r1-prompt-chain-anchor.md`

**文件清单（读）**：

- `src-tauri/src/chat_v2/prompt_builder.rs`
- `src-tauri/src/chat_v2/context.rs`
- `src-tauri/src/chat_v2/repo.rs`（metadata 单键更新、不推 `updated_at` 纪律；分支复制 `:1948-2049`）
- `src-tauri/src/chat_v2/types.rs:1057-1101`（`without_skill_contents`）
- `src-tauri/src/chat_v2/pipeline/history.rs:806-823`

**验收**：画出 metadata 单键更新链（谁写、哪把键、是否 bump `updated_at`）。标出技能正文不冻结（P2）与目录快照（P4）的落点。列出第 2 轮「prefix generation 持久化键」应插入的函数与现有同类键名。**不改产品代码。**

---

### #9 锚定员-provider

**产出**：`docs/dev/wave2-A/r1-provider-step22.md`

**文件清单（读）**：

- `src-tauri/src/providers/mod.rs` 全量关注区 + `#[cfg(test)]` 快照
- Step 22 源 SHA 映射：`35706d09` → `55846040`（`docs/0824-MERGE-PLAN.md` Step 22）
- 评审四项：P0 breakpoint 形状+端点门控；P1 include_usage 终止状态机；P1 stream_options 无条件下发；P2 Anthropic 四槽+工具 marker 死分支

**验收**：逐条「已修 / 未修 / 半修」台账，每条带行号、现有测试名字（或「零测试」）、第 5 轮建议。独立复核 55846040，不要假设评审文档仍正确。**不改产品代码。**

---

### #10 台账员（等 1–9 交卷后启动）

**产出**：`docs/dev/wave2-A-ledger.md`

汇总 1–9，含：缺口总表（P1–P11 对照）、第 2 轮代际方案采用哪一个、provider 已修/未修、调研矩阵摘要、18 不变量本轮静态自证（grep 证据，不跑测试）。不要标 Goal complete。
