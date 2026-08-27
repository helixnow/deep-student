# Wave2-A 第 1 轮 #4：Agent 框架对标调研（子代理派发 / 前缀治理 / compaction）

- 作者：调研员-Agent框架（claude-fable-5-thinking-high）
- 检索日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `061b4815`
- 铁律遵守：本轮零产品代码改动，只读 + web search + 本文档。

## 0. 调研对象与方法

对标四个外部体系，全部经 2026-08-26 当日 web search 核实：

1. **Claude Code**（子代理派发、hooks 生命周期、五段 compaction）
2. **Anthropic Messages API / Claude Agent SDK**（服务端 compaction `compact_20260112`、context editing、与 prompt cache 的交互）
3. **OpenAI Agents SDK**（runner 工具环、Sessions、`OpenAIResponsesCompactionSession`、handoffs）
4. **OpenCode**（开源，prefix 治理最激进：system 双块拆分、工具/技能/agent 列表确定性排序、compaction 作为前缀延伸）

本仓侧证据取自：`src-tauri/src/chat_v2/pipeline/hooks.rs`、`tool_loop.rs`、`multi_variant.rs`、`tools/skills_executor.rs`、`tools/subagent_executor.rs`、`workspace/agent_profile.rs`、`prompt_builder.rs`、`pipeline/compaction.rs`，以及 `docs/dev/chat-v2-subagent-runtime.md`、`docs/dev/sota-conversation-core/ROUND-01-{opencode-pi,codex-claude,pipeline}.md`。

三个只读定位（红线：不改）：`ChatAnkiToolExecutor` 注册于 `src-tauri/src/chat_v2/pipeline.rs:311`，`QBankExecutor` 注册于 `pipeline.rs:329`，`SkillsExecutor` 注册于 `pipeline.rs:337`，`GenerativeUiExecutor` 注册于 `pipeline.rs:347`。

## 1. 外部体系要点（每条含出处）

### 1.1 Claude Code 子代理派发

- 每个 subagent 运行在**自己的隔离上下文窗口**，带自定义 system prompt、工具子集、独立权限；**不继承父对话历史**，只收到父代理编写的紧凑任务简报（delegation brief），完成后只回传摘要 + token 元数据。来源：[code.claude.com/docs/en/subagents](https://code.claude.com/docs/en/subagents)、[code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window)（检索 2026-08-26）。
- 子代理会重新加载 CLAUDE.md 和相同的 MCP/skill 配置（算进子代理自己的窗口）；内置 Explore/Plan 子代理为省上下文连 CLAUDE.md 都跳过。来源同上。
- 官方定位：子代理是**防上下文膨胀的第一手段**——探索性大读留在子窗口，父窗口只收结论；compaction 只是兜底。来源：[Anthropic Cookbook：context engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)。
- Claude Code 的 compaction 是多段管线（budget reduction → snip → microcompact → context collapse → auto-compact，约 95% 容量触发）；compaction 后自动重读最近编辑过的至多 5 个文件恢复规则上下文。来源：[code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window) 及第三方 2026 实测文（tembo.io / academy.kspl.tech，检索 2026-08-26）。

### 1.2 Claude Code hooks 生命周期

- `PreToolUse`（可拦截，exit 2 阻断并把 stderr 回喂模型）→ 工具执行 → `PostToolUse`（成功，仅反馈）/ `PostToolUseFailure`（失败，仅反馈）/ `PostToolBatch`（并行批次归一后、下一次模型调用前，可停环）。
- `PreCompact`（**可阻断 compaction**）/ `PostCompact`（压缩后，可重注入上下文）。
- `SubagentStart` / `SubagentStop`（后者可拒绝子代理收工，强制继续）。
- 来源：[code.claude.com/docs/en/hooks-guide](https://code.claude.com/docs/en/hooks-guide)、continuumcode.ai、thepromptshelf.dev 2026 参考（检索 2026-08-26）。

### 1.3 Anthropic API / Claude Agent SDK compaction 与缓存

- 服务端 compaction `compact_20260112`（beta `compact-2026-01-12`）：input tokens 达阈值（≥50K，默认 150K）自动生成 `compaction` 块，后续请求自动丢弃块前内容；支持 `pause_after_compaction` 在摘要后补块。来源：[platform.claude.com/docs/en/build-with-claude/compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)。
- context editing（`clear_tool_uses_20250919` / `clear_thinking_20251015`）明确标注**会使 prompt cache 前缀失效**，官方给了 `clear_at_least` 参数：清不够多就不清，避免反复付 cache write。来源：[platform.claude.com/docs/en/build-with-claude/context-editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)。
- 官方组合拳次序：子代理隔离（脏活不进主窗）→ tool result 清除（可再取回的先逐出）→ compaction（最后压缩连贯推理线）→ memory tool（不可丢的写窗外文件）。来源：Anthropic Cookbook（同上）。

### 1.4 OpenAI Agents SDK

- Runner 工具环与本仓 tool_loop 同构：调模型 → 有 tool call 就执行并继续 → handoff 则切 agent 继续 → final output 停。来源：[developers.openai.com/api/docs/guides/agents/running-agents](https://developers.openai.com/api/docs/guides/agents/running-agents)（检索 2026-08-26）。
- 状态四选一：`result.history`（客户端全量重放）/ `session`（SDK 管历史，跑前 prepend、跑后 append——**append-only 历史**）/ `conversationId` / `previousResponseId`（服务端续接）。`OpenAIResponsesCompactionSession` 包装底层 session，按 `should_trigger_compaction` 每轮后自动调 `responses.compact`。来源：[openai.github.io/openai-agents-python/sessions](https://openai.github.io/openai-agents-python/sessions/)。
- handoff / agents-as-tools 的子 agent 同样不复用母前缀：handoff 切换 instructions（前缀必换），agents-as-tools 子 agent 是独立请求。缓存靠「system prompt 稳定 + prompt caching」而非跨 agent 共享前缀。来源同上 + lexogrine 2026 对比文。

### 1.5 OpenCode prefix 治理

- system 拆双块：S1 稳定（provider prompt + 全局 AGENTS.md + **全局技能**）、S2 动态（env + 项目级），各打 `cache_control`；跨 repo 缓存命中 87%→97.7%。来源：[opencode PR #14743](https://github.com/anomalyco/opencode/pull/14743)、[PR #14203](https://github.com/anomalyco/opencode/pull/14203)、[PR #20109](https://github.com/anomalyco/opencode/pull/20109)（检索 2026-08-26）。
- agent/skill 列表进 prompt 前**按名字确定性排序**，否则文件系统枚举序抖动 → 0% 缓存命中。来源：[issue #18215](https://github.com/anomalyco/opencode/issues/18215)、[PR #18261](https://github.com/anomalyco/opencode/pull/18261)。
- 工具 schema 里剔除 per-repo 易变字段（如 `Instance.directory`），cwd 改由 env 块提供——即「schema 字节必须会话稳定」。来源：PR #14743。
- compaction 默认做成**上一请求的前缀延伸**（附加摘要指令）而非独立新请求，保住已缓存前缀。来源：PR #14743 讨论串 + 搜索综述（检索 2026-08-26）。

## 2. 契合 / 不契合 / 改造建议矩阵

判定口径：**契合** = 本仓已达业界同等或更强；**半契合** = 方向一致但有缺口；**不契合** = 业界有明确实践而本仓缺位或相反。

| # | 维度 | 业界实践 | 本仓现状（文件:行号） | 判定 | 改造建议 |
|---|------|----------|----------------------|------|----------|
| 1 | hooks 准入链（执行前拦截） | Claude Code `PreToolUse` exit 2 阻断、stderr 回喂模型；即使 bypassPermissions 也生效 | `PipelineHook::before_tool` 返回 `ToolGateOutcome::Block(ToolResultInfo)`（`src-tauri/src/chat_v2/pipeline/hooks.rs:111-118`、`:86-89`），`ApprovalGateHook` 固定链首（`hooks.rs:139-144`），调用点 `tool_loop.rs:3191`；拦截结果经 `preflight_blocked_result`（`hooks.rs:180-223`）回喂 | **契合** | 无需动。第 2 轮 #6 P8 文档化失败语义即可（`before_turn` 可 `Err`、`before_tool` 用 outcome、`after_tool`/`before_compaction` 不可失败） |
| 2 | hooks 失败/批次切点覆盖面 | Claude Code 另有 `PostToolUseFailure`（失败后反馈）与 `PostToolBatch`（并行批次归一后、下一次模型调用前，可停环） | `after_tool` 仅在 executor 成功返回后触发（`hooks.rs:96`、`tool_loop.rs:3269-3274`）；并行批次经 `merge_round_results_in_call_order` 归一（`multi_variant.rs:1586`、tool_loop 同名函数）但无批次级钩子 | 半契合 | 第 3–4 轮可加 `after_tool_failure` / `after_round`（批次后、回喂前）切点；trait 已有默认空实现机制，追加零破坏。审计钩子（TaskAuditHook `hooks.rs:952`）可借此覆盖失败路径 |
| 3 | compaction 边界钩子 | Claude Code `PreCompact` **可阻断**、`PostCompact` 可重注入（压缩后重读至多 5 个近期文件恢复规则） | `before_compaction` 无返回值不可阻断（`hooks.rs:129-135`），调用点 `tool_loop.rs:466-468`；无 `after_compaction` 切点，压缩后仅 reload history + `compile_frozen_context`（`tool_loop.rs:470-499`） | **不契合** | 第 3 轮：`before_compaction` 升级为可返回 skip 判定（或注记 outcome），补 `after_compaction` 切点供重注入锚点/审计；不动十五段准入与 TOCTOU |
| 4 | tool_loop 工具环结构 | OpenAI Agents SDK runner：调模型 → 执行 tool calls → 继续；final output 停；session append-only 历史 | `execute_with_tools` 同构环（`tool_loop.rs:324` 起）：before_turn（`:346`）→ 环内 compaction（`:460-530`）→ 技能瞬态注入（`:575-620`）→ LLM → before_tool/after_tool（`:3191`/`:3272`）→ 回喂迭代 | **契合** | 无结构性改动。环内两处 compaction 触发（`:1365-1368` 轮末、`:1971-1986` 工具后增量）比 SDK 的「每轮后检查」更细 |
| 5 | compaction 算法形态 | Anthropic `compact_20260112`：阈值触发、摘要块替换头部、块前自动丢弃；Cookbook 建议保留任务锚点与近尾 | tail 锚定压缩（`compaction.rs:9-17`）：首 2 user turn 逐字保留 + 末 N turn（含 thought_signature 保真扫描）+ 中段摘要；`run_compaction` `compaction.rs:277`；多变体 fan-out 前预检 `compaction.rs:1158` | **契合** | 结构比服务端 compaction 更保守（双端锚定）。缺口在别处：FIFO 32K 头删抢在 compaction 前动手（`ROUND-01-pipeline.md` 第 5 条），第 3 轮把 FIFO 触发阈值让位给 compaction |
| 6 | compaction 与 prompt cache 的交互 | Anthropic 官方：清除/压缩必然打掉前缀缓存，用 `clear_at_least` 保证「清一次值回票价」；OpenCode 把 compaction 请求做成上一请求的前缀延伸，摘要生成本身吃缓存 | compaction 后直接 reload + recompile（`tool_loop.rs:478`），摘要请求与主链前缀无复用关系；无「压缩收益 ≥ 缓存重写成本」的阈值联动（触发只看 token 比例，`compaction.rs:1168`） | 半契合 | 第 4 轮：摘要生成请求复用主链已缓存前缀（OpenCode 式前缀延伸）；触发阈值联动 cache write 成本（一次压缩至少释放 X tokens 才动手，对齐 `clear_at_least` 思想） |
| 7 | 子代理 prompt 是否复用母前缀 | Claude Code / OpenAI Agents SDK / OpenCode 一致：**子代理不复用母对话前缀**，fresh context + 自有 system prompt + 任务简报；Claude Code 子代理复用的是配置层（CLAUDE.md、MCP、skills），使子代理自身的稳定前缀可被缓存 | 子代理独立 session（`subagent_executor.rs:522-584`），独立 system prompt（`:534-537`），profile instructions 驱动（`agent_profile.rs:93-111`）；上下文继承显式四档 `ContextInheritance::{None,Summary,LastNTurns,Full}`（`agent_profile.rs:49-57`，内置 profile 用 Summary/`LastNTurns{8}`：`:179`、`:198`、`:227`）；运行时回传 typed completion（`docs/dev/chat-v2-subagent-runtime.md` 不变量 3） | **契合** | 方向正确（不复用母前缀是业界共识）。缺口：子代理自身的 instructions 是否走 `prompt_builder` 稳定前缀通道未验证——第 4 轮确认 worker 运行时用 `AgentRuntimeConfig.system_instructions`（`agent_profile.rs:117`）构建时复用 `stable_system` 字节纪律，使多次派发同 profile 的子代理彼此命中 system 缓存 |
| 8 | 子代理并发/深度/完成契约 | Claude Code：子窗只回摘要 + 元数据 trailer；agent teams 每 teammate 独立窗口 | 并发 4 / 深度 3 / 单跑 600s / 阻塞等待 750s，runtime-owned completion（`docs/dev/chat-v2-subagent-runtime.md`「Concurrency and limits」「Completion Contract」）；输出截 4000 字符回父 | **契合** | 无需动。父会话 workspace 注入只活在内存的问题（`ROUND-01-pipeline.md` 第 2 条）归属其他条线 |
| 9 | system 稳定前缀 | OpenCode S1/S2 双块拆分：稳定块（provider prompt + 全局 AGENTS.md + 全局技能）与动态块分离，各打断点；禁日期等易变量进稳定块（midnight-date 事故） | P1-10 固定注入稳定前缀（`prompt_builder.rs:47`）；`build` 只产稳定层（`:542-`），`stable_system` 与动态层分离（`:724-739`）；三个字节级防护测试：白名单拼接（`:1038`）、禁运行时日期（`:1129`）、跨轮字节稳定（`:1218`） | **契合** | 本仓测试防护比 OpenCode 更系统。第 5 轮可补一条：技能/agent 列表若将来进稳定前缀，必须按名字排序（预防 OpenCode issue #18215 型抖动） |
| 10 | 会话内工具面 append-only | OpenCode：工具/agent/技能列表确定性排序（字母序）；工具 schema 剔除 per-repo 易变字段保证字节稳定 | 更强的「首见序 append-only」：`freeze_tool_schema_order_for_prompt_cache`（`tool_loop.rs:41-76`）新工具只追加尾部不动已发前缀；会话级基线持久化（load `:330-331`、store `:992-994`、merge `:78`）；schema **字节**冻结 `freeze_tool_schemas_for_prompt_cache`（`:105-128`）同名变更延迟到下一稳定窗口 | 半契合 | 名字序治理超过业界；缺口是 P3：字节冻结只在单次 `execute_with_tools` 窗口内存活（`:102-104` 注释自认），跨轮重建可能换字节。第 2 轮把 `frozen_schemas` 随会话持久化（挂 #8 的 metadata 单键链） |
| 11 | multi_variant 前缀治理 | 业界无「同 session 多变体共扇出」直接对标；最近似是 Claude Code agent teams（每 teammate 完全独立窗口、不共享前缀，成本换隔离）与 Agents SDK parallel agents-as-tools（各自独立请求） | 变体共享 session 级 `frozen_tool_schema_order`（`multi_variant.rs:1274-1275`，两处写回 `:1318-1322`、`:1681-1685`——并发写同一基线）；每变体独立 frozen capability snapshot（`:1088`）；fan-out 前统一压缩预检（`:248-268`）；变体尾部分叉 [A,X] vs [A,Y] 后 append-only 合并救不了前缀（P1，`ROUND-01-pipeline.md` 第 1/6 条） | **不契合** | 这是本仓独有场景，业界拿不来现成答案，必须自研代际方案：第 2 轮按 #7 设计稿二选一（fan-out 统一代际 / variant 级基线）；共享名字序基线的并发写回需要在代际键下加事务边界 |
| 12 | skills 渐进披露与注入治理 | Claude Code skills：目录常驻 system（子代理复载同一配置）；OpenCode：技能列表排序进稳定块、正文驻留 transcript（工具结果位置天然冻结，Pi 同款） | `load_skills` 元工具渐进披露（`skills_executor.rs:29-30`，注册 `pipeline.rs:337`）；正文经瞬态隐藏 user 消息注入，P1-8 后首轮构建冻结 + 锚定还原（`tool_loop.rs:577-611`，anchors `:603-609`），工具结果后再注入点 `:667` | 半契合 | 注入位置已冻结（对齐 OpenCode「首次注入后位置冻结」）；剩两缺口归 P2/P4：技能**正文字节**不冻结（编辑技能文件即打前缀）、技能**目录快照**缺失。第 3 轮做正文快照（挂 `without_skill_contents` 与 replay snapshot 现有机制，`multi_variant.rs:18-33` 已有雏形） |
| 13 | 审计与准入的钩子间依赖 | Claude Code hooks 彼此独立，经 stdin JSON 传上下文，无隐式共享可变状态 | `TaskAuditHook.after_tool` 隐式消费 `ApprovalGateHook` 填进 `ToolAdmission` 的 `authority_admission`/`is_external_mcp`/`trusted_automation_preauthorized`（`hooks.rs:36-52`、`:952-1035`）；顺序靠 `default_pipeline_hooks` 注释 +`default_hooks_keep_approval_gate_first` 测试（`:1481`）守住 | 半契合 | 第 1 轮 #6 P8 已排：文档化「审计消费准入产出」依赖 + 断言强化。长期若开放第三方钩子，`ToolAdmission` 字段私有化（`:38-40` 已做）是对的方向 |
| 14 | 历史 append-only 与重放 | Agents SDK session：跑前 prepend 历史、跑后 append 新项，历史本体不改写；compaction 产出显式摘要块（Anthropic `compaction` 块 / `responses.compact`） | 环内历史 `ctx.chat_history` 克隆后只尾插（`tool_loop.rs:575`、`:620`）；compaction 产出带 `tailStartMessageId` 的显式记录（`compaction.rs:966-1001`），重放经 lineage 还原；变体重放混拼缺陷归 `ROUND-01-pipeline.md` 第 1 条（不在本条线） | **契合** | 无需动；compaction 记录形态与业界「typed compaction block」同构 |

**矩阵合计 14 行**（要求 ≥8），覆盖验收要求的全部 8 个维度：hooks 准入链（行 1/2/13）、tool_loop（行 4）、multi_variant 前缀（行 11）、skills 目录（行 12）、compaction（行 3/5/6）、子代理 prompt 复用母前缀（行 7/8）、system 稳定前缀（行 9）、会话内工具面 append-only（行 10/14）。

## 3. 最不契合的 3 条

1. **行 11：multi_variant 前缀无代际治理（P1）**。变体尾部分叉后 append-only 合并救不了 [A,X] vs [A,Y]；session 级 `frozen_tool_schema_order` 被多变体并发写回（`multi_variant.rs:1318-1322` 与 `:1681-1685` 两处），业界没有同 session 多变体的现成方案，只能自研代际。这是全矩阵唯一「业界没答案 + 本仓有真实缺陷」的行。
2. **行 3：compaction 边界钩子残缺**。`before_compaction` 不可阻断（`hooks.rs:129-135`）、无 `after_compaction`，对照 Claude Code `PreCompact`（可 block）/`PostCompact`（压缩后重注入）差一整个能力面；叠加 FIFO 32K 先于 compaction 动手的次序问题，长会话前缀会在「正确压缩」之前被头删清零。
3. **行 10+12 合并看：字节冻结覆盖不完整（P2/P3）**。工具 schema 字节只冻单窗口（`tool_loop.rs:102-104`）、技能正文字节完全不冻——名字序治理是业界领先的，但 OpenCode 的教训（issue #18215、PR #14743）说明**任何一处字节抖动都会打掉整段前缀**，冻一半等于没冻。

## 4. 第 2–5 轮可落地的改造建议（3 条）

1. **第 2 轮：prefix generation 代际键落地**（对接 #7 设计稿 + #8 的 metadata 单键链）。选定 fan-out 统一代际或 variant 级基线后，把 `frozen_tool_schema_order` 与 `frozen_schemas`（字节）一起挂到 generation 键下随会话持久化；多变体对基线的两处并发写回收进同一事务边界。验收：分叉后重放字节与 live 一致，`prefix_snapshot_tests.rs` 加代际用例。
2. **第 3 轮：compaction 边界补齐**。(a) `before_compaction` 返回 skip/proceed 判定，补 `after_compaction` 切点（trait 默认实现，零破坏）；(b) FIFO trim 阈值让位：仅当 compaction 连续失败/跳过后才允许头删；(c) 技能正文快照（P2）：`load_skills` 成功时把正文字节存入会话快照，注入时读快照而非活文件，编辑技能不再打进行中会话的前缀。
3. **第 4–5 轮：compaction 请求前缀复用 + 子代理 system 缓存自证**。(a) 摘要生成请求改为主链前缀延伸（OpenCode 式），触发条件联动「至少释放 X tokens」（对齐 Anthropic `clear_at_least` 思想）；(b) 验证并测试同 profile 多次派发的子代理共享字节级 system 前缀（`AgentRuntimeConfig.system_instructions` 走 `stable_system` 纪律），给 worker/explorer 补跨派发 system 字节稳定测试。

## 5. 引用清单（检索日期均为 2026-08-26）

| 主题 | URL |
|------|-----|
| Claude Code subagents 官方文档 | https://code.claude.com/docs/en/subagents |
| Claude Code context window / compaction 时间线 | https://code.claude.com/docs/en/context-window |
| Claude Code hooks 官方指南 | https://code.claude.com/docs/en/hooks-guide |
| Anthropic 服务端 compaction（compact_20260112） | https://platform.claude.com/docs/en/build-with-claude/compaction |
| Anthropic context editing 与缓存交互 | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| Anthropic Cookbook：context engineering 组合 | https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools |
| OpenAI Agents SDK 运行环 | https://developers.openai.com/api/docs/guides/agents/running-agents |
| OpenAI Agents SDK Sessions / compaction session | https://openai.github.io/openai-agents-python/sessions/ |
| OpenCode system 双块 + 工具稳定性 | https://github.com/anomalyco/opencode/pull/14743 |
| OpenCode system 拆分先行 PR | https://github.com/anomalyco/opencode/pull/14203 |
| OpenCode 动态 user.system 分离 | https://github.com/anomalyco/opencode/pull/20109 |
| OpenCode agent/skill 排序抖动 issue | https://github.com/anomalyco/opencode/issues/18215 |
| OpenCode 排序修复 PR | https://github.com/anomalyco/opencode/pull/18261 |
| Claude Code hooks 2026 第三方参考 | https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/ 、https://continuumcode.ai/guides/claude-code-hooks/ |
| Claude Code subagents 2026 实践文 | https://www.tembo.io/blog/claude-code-subagents 、https://backgrind.com/blog/claude-code-subagents-explained/ 、https://academy.kspl.tech/blog/2026-06-05-claude-code-subagent-context-window-strategy |
