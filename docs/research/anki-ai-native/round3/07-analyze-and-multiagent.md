# Round 3 · #7 — chatanki_analyze 与管线路由同源 + Multi-agent Phase 1

> 所属调研：[Anki AI-Native](../README.md) ·分支 `cursor/anki-ai-native-research-bfca`
> 前置：Round 2 #9（plan_route LLM 路由规划）、Round 2 #6（Multi-agent Phase 0 档案）

## 问题（修复前）

### A. analyze 与管线路由三处漂移

1. **`chatanki_analyze` 永远推荐 `simple_text`**：工具只收纯文本、路由字段是硬编码
   常量，甚至有单测把「永远 simple_text」钉成契约。管线早已具备
   `plan_route`（LLM 规划）+ `decide_route`（启发式）+ forced route 三级决策，
   analyze 与它们零共享——agent 拿 analyze 的预估做决策就是拿假数据做决策。
2. **`goal` 参数假参与**：analyze 收下 goal 后只做回显，不影响任何输出。
3. **词汇表启发式三份内联漂移**：
   - `execute_analyze` 内联一份 entry-like 行计数（把 `"12"` 这种短数字行也算
     entry，与共享判定不一致）；
   - `execute_analyze` 内联一份生成参数常量（0.2/0.3、2400、0/200）；
   - `looks_like_glossary_content` + `build_generation_options` 各持真源。
   三处各自演化，analyze 的「推荐参数」与管线实际参数没有任何机制保证一致。

### B. Multi-agent 停在 Phase 0

Round 2 交付了 `content-curator` / `card-qa` 两份档案与编排流程图，但编排流程
只存在于 README 的示意图里：没有协调者提示词、没有降级规则、没有能力边界的
回归测试。

## 方案（修复后）

### A1. 统一路由决策函数（同源核心）

新增 `RouteSource`（`forced | llm | heuristic`）与 `RouteDecision`，并把三级
优先级链收敛为**唯一入口** `resolve_route_decision(forced, llm_plan, ref_data)`
（`src-tauri/src/chat_v2/tools/chatanki_executor.rs`）：

- `run_chatanki_pipeline_background` 改用它决定最终路由，并把
  `routeSource` 写进 anki_cards 块的 debug 输出（原 `routePlan` 调试块保留）；
- `execute_analyze` 改用它产出 `routing` 块——两边永远同一份代码；
- 原 `resolve_planned_route` 删除（其测试改写为
  `test_resolve_route_decision_priority_and_source`，额外锁定 source 与
  confidence/glossary/reason 的透传规则）。

`execute_analyze` 的决策路径：

| 输入形态 | 决策路径 | routeSource |
|---|---|---|
| `route` 参数显式传入 | 原样生效（与 run 的 forced 同语义） | `forced` |
| `resourceId(s)` 解析出引用元数据 + LLM 可用 | `plan_route`（goal + 引用元数据 + 文本采样，与管线同一函数同一提示词）；高置信度生效 | `llm` |
| 引用元数据存在但 LLM 不可用 / 计划低置信度 / 解析失败 | `decide_route` 引用类型计数 | `heuristic` |
| 纯文本（无图元数据） | 与管线 `PipelineInput::Content` 同语义 → `simple_text` | `heuristic` |

goal 从「回显」变成真正参与：进入 `plan_route` 的提示词影响 LLM 路由与
glossaryMode 判定。glossaryMode 与管线相同取
「高置信度 LLM 提示 ∪ `looks_like_glossary_content`」并集（对应管线
normalize 前的判定行）。

引用解析是**fail-open** 的轻量链路（`resolve_analyze_ref_data`）：会话快照
（`resolve_target_context_refs`）优先，VFS source_id
（`resolve_context_ref_from_any_id`）兜底；任何 id 解析失败降级为纯文本分析并
写入 `warnings[].code=analyze_refs_unresolved`，绝不阻断——analyze 是只读预估
工具，不承担 run 的严格校验职责（run 对无效 id 仍然硬失败）。

### A2. 输出契约（新）

```json
{
  "status": "ok",
  "goal": "记住所有定义",
  "metrics": {
    "chars": 1200, "nonEmptyLines": 60, "entryLikeLines": 45,
    "refTotal": 2, "refFiles": 1, "refImages": 1, "refOthers": 0
  },
  "routing": {
    "route": "vlm_light",
    "routeSource": "llm",
    "confidence": 0.85,
    "glossaryMode": true,
    "reason": "少量图表需要视觉补充"
  },
  "recommended": {
    "route": "vlm_light",
    "maxCards": 50,
    "glossaryMode": true,
    "segmentOverlapSize": 0,
    "maxOutputTokensOverride": 2400,
    "temperature": 0.2,
    "pipelineDefaultMaxCards": 0
  },
  "warnings": []
}
```

- `metrics.ref*` 仅在传了 `resourceId(s)` 且解析成功时出现；
- `routing.confidence` 仅 `routeSource=llm` 时非 null；
- `warnings` 仅有内容时出现。

**哪些能回传给 `chatanki_run`（agent 可执行动作）：**

| analyze 字段 | 回传为 | 说明 |
|---|---|---|
| `recommended.route` | run 的 `route` | 只在需要固定路由时传；不传则管线自己再跑同一条决策链 |
| `recommended.maxCards` | run 的 `maxCards` | 1..=100；词汇表 = 条目数 + max(条目数/10, 2) 余量，封顶 100 |
| 调用方自己的 `goal` | run 的 `goal` | analyze 不改写 goal，仅让它参与路由 |

**哪些由管线内自算（仅供解释，run/start 没有对应参数）：**

| analyze 字段 | 管线内来源 |
|---|---|
| `recommended.temperature` | `glossary_generation_knobs()` → `AnkiGenerationOptions.temperature` |
| `recommended.maxOutputTokensOverride` | 同上 → `max_output_tokens_override` |
| `recommended.segmentOverlapSize` | 同上 → `segment_overlap_size` |
| `recommended.pipelineDefaultMaxCards` | `default_max_cards_for_content()`（未显式传 maxCards 时的内部默认；0=词汇表不设上限） |
| `recommended.glossaryMode` / `routing.glossaryMode` | 管线 normalize 判定（LLM 提示 ∪ 内容启发式） |

### A3. 词汇表启发式收敛为共享函数

| 共享函数 | 消灭的内联副本 | 调用方 |
|---|---|---|
| `count_entry_like_lines`（以 `is_glossary_entry_start` 为唯一裁判） | analyze 内联 entry 计数（含 `"12"` 误判） | `execute_analyze`(metrics)、`looks_like_glossary_content` |
| `glossary_generation_knobs` | analyze 内联 0.2/0.3、2400、0/200 常量 | `build_generation_options`、`build_analyze_output` |
| `default_max_cards_for_content` | build_generation_options 内联 10/30/80 档位 | `build_generation_options`、`build_analyze_output` |
| `suggest_max_cards_arg` | （新增）skill 文档「条目数+余量」口径的机器实现 | `build_analyze_output` |

对齐不只靠共享代码，还有测试双保险：
`test_execute_analyze_recommended_aligns_build_generation_options` 对同一段内容
分别跑 analyze 与 `build_generation_options`，逐字段断言相等。

### A4. 测试清单（chatanki_executor.rs / custom_agents.rs）

| # | 测试 | 锁定的契约 |
|---|---|---|
| 1 | `test_execute_analyze_text_only_is_heuristic_simple_text` | 无图纯文本 → simple_text / heuristic / confidence=null / reason 含「启发式」 |
| 2 | `test_execute_analyze_recommended_aligns_build_generation_options` | recommended 与管线参数装配逐字段一致（glossary + plain 双向） |
| 3 | `test_execute_analyze_glossary_metrics_share_entry_counting` | entryLikeLines 来自共享 `count_entry_like_lines`；短数字行漂移已消灭 |
| 4 | `test_execute_analyze_forced_route_source` | route 参数 → routeSource=forced |
| 5 | `test_execute_analyze_rejects_invalid_route` | 非法 route 拒绝 |
| 6 | `test_execute_analyze_rejects_blank_input` | content 与 resourceIds 全缺 → 拒绝 |
| 7 | `test_execute_analyze_unresolvable_refs_fail_open_with_warning` | 引用解析失败 fail-open + warnings 契约 |
| 8 | `test_execute_analyze_suggested_max_cards_boundaries` | maxCards 档位（10/30/80）与词汇表口径（条目+余量、封顶 100、pipelineDefault=0） |
| 9 | `test_build_analyze_output_with_image_refs_and_llm_decision` | 图引用 → vlm 路由；LLM 决策透传 confidence/reason/glossary 并集 |
| 10 | `test_resolve_route_decision_priority_and_source` | 共享决策函数的优先级链 + source 语义（管线与 analyze 同源的根） |
| 11 | `test_shared_glossary_helpers_consistency` | 共享函数取值表（knobs/档位/建议值） |
| 12 | `custom_agents::chatanki_and_workspace_document_tools_are_dropped_fail_closed` | Phase 1 能力边界（见下） |

## B. Multi-agent Phase 1：coordinator 编排固化

### 交付物

1. **`agents/skills/card-coordinator/SKILL.md`**（新）：主代理激活的协调者
   提示词，固化五阶段总线
   `content-curator（策展）→ chatanki_run（生成）→ card-qa（质检）→
   batch_update_cards（修正）→ 复检交付`，并写死：
   - 每阶段的委派入参模板（与 Phase 0 README 的调用示例一致）；
   - **降级规则**：档案未安装 / 无子代理工具 → `chatanki_analyze` + 决策树
     内联策展、四类自查内联质检（Phase 1 不把多代理设为硬依赖）；
   - 复检续跑（`resume_agent_session_id`）与循环上限（3 轮）；
   - ask_user 纪律沿用 chatanki skill（>3 张先确认）。
2. **chatanki skill 决策树**（`src/features/chat/skills/builtin/index.ts`）：
   新增「策展 → 生成 → 质检 决策树」章节，主代理不装任何额外档案也能按
   同一心智模型走单代理版闭环；analyze 工具描述同步新契约。
3. **`agents/README.md`** 升级到 Phase 1：编排图补充 analyze 参数来源、
   新增「workspace 文档工具边界」章节。

### workspace_read/update_document 的处置（为什么不进 worker 白名单）

`builtin-workspace_read_document` / `builtin-workspace_update_document` 不在
自定义子代理安全全集（`headless_allowed_tools() ∪ workspace_send/query`）内。
Phase 1 **不放宽**白名单，理由：

- worker 的实际权限边界就是工具白名单（`agent_profile.rs` 模块注释明示）；
  放宽等于给所有自定义档案开共享文档写权，与「子代理只产出文本契约」的
  Phase 0/1 架构相悖；
- 编排上不需要：材料/卡片 JSON 走任务入参下行，裁决/补丁走最终回答上行，
  运行时自动交付，无共享状态即无并发写冲突。

作为替代，能力边界被**写进档案说明**（card-coordinator SKILL「能力边界」节 +
README「workspace 文档工具边界」节），并补 fail-closed 测试
`chatanki_and_workspace_document_tools_are_dropped_fail_closed` 双向钉死：
安全全集不含这些工具 + 档案声明后被 sanitize 剔除。未来若确需放宽，测试会
先红，迫使同步评审全部档案与审批语义。

## 影响面

- `src-tauri/src/chat_v2/tools/chatanki_executor.rs`：
  `ChatAnkiAnalyzeArgs`（+route/resourceId/resourceIds，content 可选）、
  `execute_analyze` 重写、`RouteSource`/`RouteDecision`/`resolve_route_decision`、
  `resolve_analyze_ref_data`、`build_analyze_output`、`count_entry_like_lines`、
  `glossary_generation_knobs`、`default_max_cards_for_content`、
  `suggest_max_cards_arg`；管线路由段改用统一决策并输出 `routeSource`。
  **未触碰** `execute_transform` / `fill_missing_llm` / VlmFull 大块。
- `src-tauri/src/chat_v2/workspace/custom_agents.rs`：仅新增 fail-closed 测试。
- `src/features/chat/skills/builtin/index.ts`：analyze 工具 schema/描述 +
  skill content 决策树章节（transform schema 未动）。
- `docs/anki-agent-tools.md`：analyze 节改为新契约。
- `docs/research/anki-ai-native/agents/**`：Phase 1 编排。

## 遗留

- analyze 的引用解析是「元数据轻量版」（不解析 VFS 存储的完整 ref data JSON），
  folder 展开类复合引用的计数可能与 run 管线的 merged ref 有出入——预估工具
  可接受，已在工具描述中说明按引用元数据计数。
- plan_route 在 analyze 中的调用会产生一次真实 LLM 计费（CallerType::Anki）；
  高频预估场景可考虑加会话级路由计划缓存（Round 4 候选）。
- 端到端 subagent_call 冒烟仍需桌面环境（Phase 0 起的已知待办）。
