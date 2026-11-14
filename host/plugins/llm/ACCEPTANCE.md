# L02-llm-manager 独立验收（R1-review-llm，2026-11-05）

结论：不通过

**恢复审读基线 `13fd67329` / main `e9df01a3c`**：本轮以实际源码修正旧阻塞描述。F3 llmUsage已正式提供，raw路径已有record调用，原三个日志遗漏已有修复，配置字段类型校验已补；剩余原文/精度/端到端证据见§11。已有修复不因报告旧文而重复派回。

**D11 tokenizer原失败用例已解除（2026-11-05）**：正常main `0ed7917b8`批准并根声明tiktoken@1.0.22，review固定SHA `3149fdc0f8cf74836d258f144a21f10cffca76e6`。独立job `20261104164359-e55d67`仅原tokens_command标题，1passed、原exit0、无Errors/Unhandled；真实kernel→L02→F7 tokenizer已加载并返回预期精确结果。详见§10。旧MODULE_NOT_FOUND/整作业exit1保留历史，D11及本单例不自动扩大整L02-02算法/平台签收。

**L02-04最新局部复核（review `fc062c667`）**：已确认`8d02f923c/41e9f134d`修复缺字段、load/parse上下文及命令专属类型集合，复用独立门禁中两条实际passed，不重跑。新增只读生产函数探针`20261104142602-d5ed8d`仍复现整数外形浮点、usize溢出及重复字段被接受；04父项保持未决，详见§9。

**最新OCR后继（review `b70b5e238`，当前`ddb6550bd`相关代码无差异）**：`87607ecdc`已将OCR准备改为共享异步prepare。独立门禁子作业`20261104131022-87fc5b`实际通过新增prepareCandidates→runPrepared Codex向量，L02-01已识别的活跃认证/主要调用/Model2/OCR阻断问题闭合；不扩签其他模型功能。该作业整体exit1，tokenizer正式依赖缺失仍阻止L02-02与整门禁通过，见§8。§7中OCR未修为此前基线状态。

复核基线：`f23c98702`。依据契约、Rust/TS 源码和本次执行结果；未沿用实现者进度声明。

定向续审（协调者指令 1）：合并 main 快照 `35b4fbfdf`（merge `12fab466c`）后，L02-07 的路径问题已修复，但整项尚未闭合；L02-08 无生产消费修复证据，保持未勾选。其他编号本轮未复核，保持原勾选状态；下文初审细节的行号/结果属于初审基线，最新证据见 §5。

**最新main复验（01/03/08，review `a17989895`）**：L02 `99d95149a`及异步Model2后继`d9d4f5569/44e7e8a76/fe2435e5e`已集成，L16消费修复`374914c1d`仍非main祖先。两项最小jobs独立通过（3+5条，原exit0，无Errors），签收Codex主要调用/异步Model2指定路径、raw请求转换和Anki路由提供方子项。OCR准备、raw usage及L16完整消费仍未决，不授父项全通过。§7为最新，§6候选未集成状态为历史。

## 必须修复

- [x] **L02-01：活跃认证及主要调用、Model2/OCR准备阻断已修复签收。** 主路径沿用§7独立3条通过证据；`87607ecdc`进一步在index注入同一llmCodexAuth，ocr_hedge_service.ts:94-98 await共享prepare并保留isCodex，随后:135-142走真实streaming.singleShotCompletion。独立作业`20261104131022-87fc5b`执行新增OCR候选保留/isCodex=true/runPrepared返回authenticated/不额外refresh断言通过。指定修复闭合，不签所有OCR引擎/平台、raw usage或完整用户配置选择；详见§8。
- [ ] **L02-02：正式依赖缺包已解除，指定短文本命令已独立通过；完整编码/采样范围仍未签全。** D11 main `0ed7917b8`根声明tiktoken@1.0.22；job `20261104164359-e55d67`仅原生产命令标题1passed/exit0，覆盖默认编码的英文/空串/特殊token、gpt-4o中文、空texts及precise/tokenizer返回形状。原MODULE_NOT_FOUND不再作为当前阻塞派回。Rust token_budget.rs:37-85,105-130的完整编码/长文本采样与平台范围不据本单例或依赖批准扩签；历史原失败退出码不改。
- [ ] **L02-03：provider转换已签，raw usage记录已接，数值/选择顺序与真实SQL组合仍待闭合。** 当前已无旧completion.ts；`src/raw_prompt_service.ts:95-106,171-199`在解析/归一化失败及成功路径调用owner recorder，`index.ts:119-123`从ctx取llmUsage，F3 `host/platform/storage/index.ts:157-165`实际提供。仍有 `src/usage.ts:29-32,56-76`先逐项转换再fallback、统一min(u32MAX)的差异；Rust `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:9619-9671`先选存在字段再as_u64，普通计数用as u32截断，只有cache另行clamp。raw的response.json也先丢数值词法。现有raw_prompt_service.test.ts:48-51使用外部recorder seam，不证明真实SQL数值链。不要重复派回已修的请求转换/record调用。
- [ ] **L02-04：缺字段/上下文/命令类型子项已修，预算原文serde边界仍不同。** `src/budget_commands.ts:17-47`已拒绝缺字段，`:61-77`保留load/parse上下文，`:81-88`正确排除learner_profile；旧“{}成功/无上下文”不再派回。残差在`:18`的JSON.parse丢失词法/重复字段，`:24-27`仅Number.isInteger和非负校验、无usize上界。独立探针`20261104142602-d5ed8d`实测总预算1.0、18446744073709551616、重复total_budget全被接受；Rust BudgetConfig derive Deserialize的usize/重复字段应拒绝（`src-tauri/crates/dstu-storage/src/injection_budget.rs:99-106,436-448`）。需保留原文的字段/数字语义和合法全范围，不以JS安全整数上限替代Rust范围，详见§9。
- [ ] **L02-05：配置字段类型已补校验，原文serde诊断/重复字段/数字语义仍未闭合。** `src/config_values.ts:69-76,120-147`现在拒绝数字模型id及多种错误字段，旧 `{model2_config_id:123}` 漏出已修。持久化加载仍普通JSON.parse（`src/config_store.ts`的getModelAssignments、`src/config_values.ts:79-80`）；例如重复model2_config_id后值覆盖，无法复刻typed输入顺序，u64还缺完整上界/词法。Rust `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:7881-7887`直接serde解码，错误Display仍需对应。测试/具体范围见§11。
- [x] **L02-06：原三个warn/error遗漏已修复并独立签收。** `src/control.ts:49-57`损坏策略warn后默认，`index.ts:214-227`保存失败error后传播，`src/config_store.ts:550-562`缺供应商warn后跳过；分别对照 Rust `llm_manager/routing.rs:556-560`、`src-tauri/src/commands.rs:2165-2169`、`llm_manager/mod.rs:6430-6431`。本轮job `20261105000325-ee59c8`实际通过 `tests/control.test.ts:103-114`和`tests/config_store.test.ts:227-236`，原exit0、无Errors/Unhandled。只关闭原三处遗漏，完整serde错误文案仍归05。
- [ ] **L02-07：实际666ported/1pending，生成表头与规格仍未闭合。** 初审229行错误路径已修；当前 `TESTMAP.md:478`仅Codex bridge原测试pending，`:12`仍写24ported/643pending；`SPEC.md:71-79`全局项仍未填。本轮逐行计数及wiring 666/0确认，不再使用旧662/5口径。Rust对照见各TESTMAP原文件/测试位置。
- [ ] **L02-08：Anki路由提供方已签，消费者已main，完整组合运行待验。** 当前 `anki/src/plugin-handlers-generation.ts:54`获取llmAnkiRouting，`anki/src/generation-service.ts:183`及`generation-critic.ts:129-136`已有消费；旧“消费方非main”已过时。提供方§7的角色选择/失败顺序签收保留，两真实插件完整组合证据仍待。Rust对照 `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:7734-7749`、`model2_pipeline.rs:8616-8624`。

## 建议

把 `index.ts:169-304` 中预算、恢复和用量处理移入 src；入口只保留服务组合和命令注册（ARCHITECTURE/quality 的接线约定）。恢复和状态命令的包装顺序正确，可在保持顺序的前提下整理。

## 已核实通过

- [x] 命令/服务使用 lowerCamelCase 服务名，`llm/essayGrading` 的声明和 provide 一致（`index.ts:65,86,382`、`api.ts:15,70`）。跨插件导入使用对方 api；配置写入走 settings/secrets。生产 boundary 扫描未抑制违规 `[]`。
- [x] 供应商批量保存先完成所有 header/origin 校验再写安全存储（`src/config_store.ts:398-423` ↔ `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:6023-6063`）；供应商 key/备用 key/敏感头的 UI 掩码分支已核对（TS:360-385 ↔ Rust:5776-5814）。
- [x] profile 能力迁移的尽力保存、快照刷新、隐藏模型列表处理对应 Rust 分支（`src/config_profiles.ts:63-127` ↔ `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:6220-6403`）。未把非事务的顺序写入误改成“应存在数据库事务”。
- [x] 下面 15 条 Anki 原测试的断言含义确实移植，测试调用真实纯函数；但缺生产接线，所以不能据此成立 B 级。

## 1. 命令抽查（18 条）

表内 TS 路径相对 `host/plugins/llm/`；`C` = `src-tauri/src/commands.rs`，`M` = `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs`。通过仅指所列分支；有共用缺陷的命令明确列“问题”。

| # | 命令 | 结论、TS 与 Rust 证据 |
|---|---|---|
| 1 | cancel_stream | 通过取消/返回主语义：未知事件也 true；先 abort 后 pending 标记。`index.ts:91-94`、`src/control.ts:18-26` ↔ C:342-352、M:5458-5528。日志未完整保留，见 L02-06。 |
| 2 | llm_get_failover_policy | 问题 L02-06；缺省/空/损坏回默认及 DB 错误类型正确，但损坏无 warn。`src/control.ts:33-39` ↔ `src-tauri/crates/dstu-llm/src/llm_manager/routing.rs:549-564`。 |
| 3 | llm_set_failover_policy | 通过所查包装：反序列化默认值后写原 setting key，unit 由 kernel 转 null。`index.ts:96-97`、`src/control.ts:41-46` ↔ routing.rs:568-573,790-794；`host/kernel/commands.ts:205`。 |
| 4 | get_api_configurations | 问题 L02-01/05/06；builtin 掩码与 resolvedAdapterId 注入通过。`index.ts:100-109`、`src/config_store.ts:566-580` ↔ C:2128-2146、M:6417-6435。 |
| 5 | save_api_configurations | 问题 L02-06；过滤 builtin、解密、flatten、先 vendors 后 profiles 的顺序通过。`index.ts:113-118`、`src/config_store.ts:605-618,556-561` ↔ C:2150-2172、M:7905-7925,6406-6413。 |
| 6 | get_vendor_configs | 问题 L02-05 的存储解码；有效配置的 bootstrap、内置字段覆盖、三类凭据掩码通过。`src/config_store.ts:342-387` ↔ C:2194-2195、M:5756-5814。 |
| 7 | save_vendor_configs | 通过抽查校验/写入顺序：跨配置校验在所有 secret 写之前，origin 改变不能复用掩码 key，no-auth 分支清 key。`src/config_store.ts:390-538` ↔ C:2199-2203、M:6005-6218。 |
| 8 | get_model_profiles | 问题 L02-05 的宽松字段解码；迁移/快照/隐藏列表主路径通过。`src/config_profiles.ts:32-108` ↔ C:2207-2208、M:6220-6321。 |
| 9 | save_model_profiles | 通过所查分支：先保存已知 builtin 的隐藏集合，再按 vendor 归一并写 profiles；无新增事务。`src/config_profiles.ts:111-127` ↔ C:2212-2216、M:6329-6403。 |
| 10 | get_model_assignments | 问题 L02-05；缺省 null 字段正确，错误类型值未验证。`src/config_store.ts:779-792` ↔ C:2176-2179、M:7881-7889。 |
| 11 | save_model_assignments | 通过所查 wrapper：序列化写 `model_assignments`，写失败 Database，unit→null。`index.ts:161-166`、`src/config_store.ts:795-803` ↔ C:2183-2189、M:7893-7901。 |
| 12 | get_injection_budget_config | 问题 L02-04：缺省配置正确，有值时没有 serde 结构验证。`index.ts:170-190` ↔ C:6914-6924、`dstu-storage/src/injection_budget.rs:436-448`。 |
| 13 | simulate_budget_allocation | 问题 L02-04：额外接受 learner_profile、加载错误上下文变化。type→content→priority/source 的正常顺序与默认 medium/test 通过。`index.ts:193-234`、`src/injection_budget.ts:287-310` ↔ C:6928-6995。 |
| 14 | estimate_tokens | 问题 L02-02；model 被忽略、precise/tokenizer 和数量变化。`index.ts:276-277`、`src/tokens.ts:64-87` ↔ C:317-337。 |
| 15 | check_api_config_status | 通过包装顺序：configs 失败传播；assignments 失败仅使 has_assignments=false；四个 snake_case 返回键一致。`index.ts:238-258` ↔ `src-tauri/crates/dstu-llm/src/config_recovery.rs:193-217`。 |
| 16 | restore_default_api_configs | 通过包装顺序：先保存配置再清模型分配；两种错误前缀及成功文字一致，无凭空增加事务。`index.ts:261-272` ↔ config_recovery.rs:167-188。 |
| 17 | call_llm_for_boundary | 问题 L02-01/03；外层返回 assistant_message 和两个零 token 字段正确，不能掩盖内部模型请求/用量分支差异。`index.ts:346-378`、`src/completion.ts:51-126,188-238` ↔ C:4051 起、`model2_pipeline.rs:9050-9121,9324`。 |
| 18 | test_api_connection | 问题 L02-01：Codex 分支固定拒绝代替认证请求。`index.ts:325-343`、`src/connection_test.ts:653-656` ↔ C:3573-3595。 |

契约交叉核对：`contracts/ipc/L02-llm-manager.json:6,39,105,129,193-370,477-666,750`。unit→null 已核对 kernel；没有把 TS handler 的 void 误判成 wire undefined。

## 2. TESTMAP 真实性抽查（15 条）

`R` = `src-tauri/crates/dstu-llm/src/anki_model_routing.rs`；`T` = `host/plugins/llm/tests/anki_model_routing.test.ts`。每行均为 **断言通过、生产接线有问题（L02-08）**；TESTMAP:24-38 逐行对应。

| 原 Rust 测试名 | R 行 | T 行 | 已核对的断言 |
|---|---:|---:|---|
| mode_defaults_to_auto | 450 | 47 | 旧 options、空对象、非法 JSON 都 auto |
| mode_parses_single_and_aliases | 462 | 55 | single/OFF/disabled 与未知值 |
| full_slots_assign_roles_by_strength | 489 | 66 | 四角色槽位、降级标志、三配置去重 |
| missing_main_degrades_planner_and_critic_to_anki_slot | 513 | 89 | planner/critic 降级，generator 不降级 |
| missing_anki_slot_degrades_generator_to_main | 527 | 102 | generator 降级主槽，planner 保持 |
| missing_vision_degrades_vlm_to_generator_model | 539 | 113 | VLM 降级且非多模态 |
| single_configured_model_serves_all_roles | 550 | 123 | 四角色同配置与各降级标志 |
| empty_slots_yield_no_plan | 569 | 141 | 两模式 null、槽位 empty |
| only_vision_slot_still_produces_plan | 576 | 147 | 仅视觉槽仍有计划 |
| single_mode_uses_base_model_for_all_roles | 594 | 165 | 全角色基础配置、唯一配置数 |
| plan_serializes_with_all_roles_and_reasons | 606 | 176 | 实际 plan JSON roundtrip 和日志路径 |
| build_slots_resolves_configured_assignments | 628 | 195 | assignment、reasoning、缺视觉 |
| build_slots_skips_disabled_and_non_text_configs | 647 | 212 | 禁用/嵌入不能进入任一文本槽 |
| build_slots_vision_prefers_ocr_assignment_then_falls_back | 665 | 227 | OCR 明确分配及默认首个 VLM |
| build_slots_vision_uses_multimodal_main_or_anki_before_stranger_configs | 685 | 243 | 主槽优先于排在前面的陌生 VLM |

这些测试并非自造字面量断言。但 wiring 有两种漏检：`scripts/electron-migration/wiring.mjs:74` 跳过不存在的文件；`:76-78` 只要求同一测试文件的任一直接导入已接线。本测试同时导入 config_store（T:8），使完全未接入的 anki_model_routing 也被计为已接线。全局计数不能替代逐模块核查。

无 merged/obsolete 行，无需审批豁免；`migration/approvals.json` 没有允许删除这些测试的记录。缺失 229 路径是账本问题，实际测试文件多数存在于插件 tests，不能称为 229 条测试全部未实现。

## 3. 亲自运行的原始输出摘要

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm
 Test Files  75 passed (75)
      Tests  1016 passed | 1 skipped (1017)
   Start at  11:35:30
   Duration  46.59s
$ node scripts/electron-migration/importable.mjs host/plugins/llm/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane llm
合计 ported 659，其中所测模块未从 index.ts 接入 0（0.0%）
```

均 exit 0。**vitest 路径过滤为子串，以上命令也匹配 llm-providers**：包含其 18 文件/279 用例；L02 自身为 57 文件/738 passed，不把 provider 测试重复计为 L02 原测试。日志中 CustomModes 的 warn 是实际日志输出，不是失败。

额外只读内存探针（真实类，未访问真实凭据/网络）输出：

```json
{"providerHasUsableSession":true,"llmHasUsableSession":false,"tokenEstimate":{"total":3,"per_message":[3],"precise":false,"tokenizer":"heuristic"},"extraInjectionType":"LearnerProfile"}
```

输入为符合 Rust serde 的 camelCase 会话、`Hello world`/`gpt-4`、`learner_profile`。这里只运行 TS，不运行 Rust。

## 4. 架构与语义差异

- **通过**：生产导入边界、服务命名、配置表由平台 settings 所有者写入；本次扫描无 console/生产测试替身导入。essay 服务通过 vfs-repos API 消费仓储。
- **问题**：raw prompt 复制 L01 的协议逻辑；Codex 绕过活跃状态所有者；Anki 模块虽有测试却未提供服务/接线；入口含预算业务逻辑。
- **缺陷（应修）**：L02-01～08 为本次发现的阻塞清单。细分包括 OAuth 状态键/刷新请求、token 算法、raw prompt 请求与用量、预算校验/类型/文案、配置 serde、日志、账本、生产接线。
- **已登记平台差异**：`SPEC.md:43` 登记过 Codex/usage 缺口，但不是批准删除功能；failover 已在 `index.ts:350` 接入，不继续沿用该条旧“缺 failover”自述。`tokens.ts:5-7` 自述采用移动端 heuristic 不是桌面平台裁定。`decisions.md:34-35,52-59` 的诊断格式/毫秒精度决定不能解释上述业务差异。

## 5. 定向续审：L02-07/08（不重复全量测试）

| 编号 | 修复提交/当前证据 | 真实生产入口 | 检查与结论 |
|---|---|---|---|
| L02-07 | `b4a896023` 修正 TESTMAP 目标路径；当前状态最后变更 `4a9650c08` | 新 streaming/provider request 服务确已在 `index.ts:91-95` provide；这不证明所有 ported 模块均被消费 | 只读逐行路径+原测试名检查输出 `{"ported":662,"missingPathOrName":[]}`，exit 0。路径部分修复确认；5 pending、表头和 SPEC 全局未完成，整项仍未勾选 |
| L02-08 | 未找到 Anki routing 修复提交；`src/anki_model_routing.ts:139,238` 仍只有测试调用 | `api.ts:152-175` 的 LLMManager 没有 Anki 路由方法；`src/service.ts` 未导入/调用 buildSlots/planRouting。新增 `llmProviderRequests.prepareModel2`（`src/provider_requests_service.ts:9-19`）只是 provider 转换/诊断，不是 Anki 槽位决策 | 非测试全 host 搜索 exit 0；只命中定义/注释及 Anki 侧 `resolveAnkiRoleDecision` 接口和调用（`host/plugins/anki/src/anki-critic.ts:648,754`），没有连接至 L02 该模块的实现。保持未勾选；无修复故不重跑旧纯函数测试 |

仍 pending 的原测试名（当前 TESTMAP）：`stale_stream_hook_owner_cannot_unregister_replacement`、`prepare_frontend_mcp_tool_for_legacy_api_encodes_invalid_names_with_namespace_prefix`、`convert_openai_tool_call_treats_empty_string_arguments_as_empty_object`、`convert_openai_tool_call_treats_whitespace_arguments_as_empty_object`、`authoring_tool_never_repairs_truncated_question_or_material_arrays`。原 8 条 OCR pending 已改为 ported；本轮只确认账本变化，不将新增其他模块全数视为完成独立语义审读。

路径检查在工作树以 `node --input-type=module` 读取每条 ported 的目标文件、核对原测试名文本，未改测试或生成账本。用于复核剩余门禁的命令：

```text
$ npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 75.7% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
exit 1
```

21 是全仓问题数，不全归 L02；没有把“路径与标题存在”当成所有测试已运行通过。本轮不授予 B，也不重跑三套全量测试。

## 6. 01/03/08限量续审：L02 99d95149a + L16 18c563a46

### 基线与范围

中断前已固定并完成主要读码；恢复后按要求核对`git log --oneline -20`/`git status`（干净）与TESTMAP，不重做读过的实现。两完整候选对main的ancestor检查均exit1；`0982ae65c`路由提供提交本身已是main祖先（exit0），不能把整条消费链“存在于分支”写成“main已完成”。以下TS行号按各候选固定，非review旧工作树。

### 编号 → 已修hash → 真实入口/剩余缺口

| 编号 | 已修版本与生产入口 | 静态结论 | 仍缺/验收边界 |
|---|---|---|---|
| 01 活跃状态 | `65c796fab`；L02 `index.ts:85-90` → `ctx.llmCodexAuth.status().hasUsableSession` → `src/config_store.ts:124-125` | 正确使用同一活跃管理器，不是把snake_case简单改camelCase的存储副本；可反映登出/reauth状态 | 候选独立运行待集成；不得继续派回旧字段错误 |
| 01 连接/流式/raw | `51639c462`连接与stream，`d9823d11d`raw，`cafa8660a`essay/RAG；`index.ts:92,110,118,316,350`注入共享auth；`connection_test.ts:656-668`准备Responses及60s send；`streaming_service.ts:28-47`按模式选择stream/nonstream方法并传权威协议 | 主要入口已不再固定拒绝OAuth；shared401刷新路径确实被调用 | `provider_requests_service.ts:16`与`ocr_hedge_service.ts:94-99`仍走拒绝Codex的同步plain prepare；完整Model2/OCR路径不可据主入口签全等 |
| 03 请求转换 | `d9823d11d`；`index.ts:329-351` boundary → `completion.ts:30-40` validateReasoning/applyReasoning/applyGeneration → `:70-81`真实adapter/共享Codex prepare/send → `:98-101`协议响应归一 | 原“相似替代”请求体/端点拼接缺陷已移除；非Codex经原plain准备，Codex经权威协议共享服务 | 本轮没有验证所有失败/重试端到端；usage仍完全未接 |
| 03 usage | `completion.ts:94-101`两个失败分支和成功return；`RawPromptProviderRuntime:25-28`只含adapters/codex | **仍未修**：成功API/heuristic及解析失败记录均缺，Rust模型流水线:9235-9270,9305-9338有对应写入 | 需L02消费公开collector；候选F3 `storage/llm-usage.ts:833,905,923`虽有实现，`storage/api.ts/index.ts`无记录入口导出，属于F3提供面+L02接线联合项；不得自行写usage表 |
| 08 路由提供 | `0982ae65c`；L02 `api.ts:189-196,253`+`index.ts:98` → `anki_routing_service.ts:13-28` | 按顺序读assignments/configs；任一步失败debug并空槽，成功真实buildSlots/planRouting/logDebugPlan/planDecision。对应Rust mod.rs:7734-7749和pipeline:8616-8624 | 原纯函数无调用问题已消除；只提供路由不代表全部Anki生成/critic模型调用均等价 |
| 08 L16实际消费 | `374914c1d`，固定树`18c563a46`；Anki `src/plugin.ts:71,323` → generation handlers `:54-62` → generation-service `:396-413,538`选generator、`:1008-1012`选critic | 真实业务路径读取ctx.llmAnkiRouting，不只是descriptor/API声明；跨插件只经`llm/api.ts` | L16候选未main；两个真实插件同宿主消费/生成链尚无本轮独立运行证据。其critic raw调用与usage不在本项证明范围 |

### 测试真实性与最小验证（本轮仅静态）

- `99d95149a:host/plugins/llm/tests/codex_streaming_integration.test.ts:44-60`安装真实L01/L02/translation，用本地HTTP验证旧token→401→刷新→新token与实际llmStreaming、连接命令；`:75-76`经真实logout验证活跃状态变化。此测试没有mock共享auth/sender。`:62,66`为boundary/RAG配置选择方法加spy固定config，故不能称为完整用户配置读取链验证；`:68`直接构造真实essay transport，不等于公开essay命令全链。测试变更归属`f29e7fcd3/3c2ec794b/cfe9861d3`等，未运行。
- `tests/model2_pipeline_completion.test.ts:192-205`通过真实callRawPrompt/AnthropicAdapter验证thinking保留、temperature去除、完整endpoint不重复及Accept JSON，仅fetch是外部seam。Rust依据pipeline:9058-9121。没有usage断言，不能用该绿灯关闭03父项。
- `tests/anki_routing_service.test.ts:8-35`经公开llmAnkiRouting调用真实路由，配置读取方法替身隔离配置依赖；验证角色及两步失败顺序。L16 `tests/anki-generation-service.test.ts:294-343`用外部routing seam验证真实generator/critic消费。两边分别有价值，但不是两真实插件组合运行证据，均未独立运行。

候选进入可运行基线后，最小jobs可分别运行`host/plugins/llm/tests/codex_streaming_integration.test.ts`、`host/plugins/llm/tests/anki_routing_service.test.ts`，raw只选`model2_pipeline_completion.test.ts -t 'raw_prompt|raw prompt'`；L16只选其`anki-generation-service.test.ts -t 'consumes L02 anki routing'`并与其owner协调。不在未集成旧源码上提交同名测试来冒充候选验证。

### 提交C1转派/保留队列（仅已确认剩余入口）

- **L02-01**：同步`llmProviderRequests.prepareModel2`与OCR prepareCandidates仍拒绝/跳过Codex。`prepared_request.ts:77-78`作为plain helper拒绝OAuth本身正确，缺陷是调用者仍将OAuth送入它；不得为此去掉helper原不变量。由L02改消费异步共享prepare，C1跟踪集成。
- **L02-03**：记录成功及解析/归一化失败usage；F3需公开记录接缝，L02按Rust调用。当前未发现已接写入的代码，保持原owner队列，不标“日志API存在即完成”。
- **跨lane图片**：候选L02 src/index检索prepareRemoteImages无匹配；非Codex同步路径仍不预取。此为原L01-01/L02消费队列，不因Codex共享prepare内部能预取而关闭全部请求路径。
- **L02-08**：不再派“新增路由API/消费实现”；待L16集成及限定动态组合。没有在此轮新造反例或修改原不变量。

以上为允许审计文件中的C1抄送/队列证据，未修改实现者文件或自行实施修复。其余02/04/05/06/07仍由原owner闭合，不在本轮扩审：已观察`44c4e7468`将estimate_tokens接F7 tokenizer（候选index:258-259/tokens:71-83），不再沿用“当前恒heuristic”描述；预算已抽到budget_commands、配置解码有新提交，但不凭存在性擅勾整项。§5的TESTMAP662/5是旧快照，候选当前自述664/3及旧生成表头也不能替代完整原测试验收。

本轮候选测试job id/runner退出码/Errors均不适用。恢复要求的只读ledger另通过全局队列提交`20261104085104-05708d`，结果见审计汇总；它检查review现有合入基线，不是99d95149a候选runner证据。所有新增重检查继续使用全局jobs，未改独立验收文件为实现者自述让路。

## 7. main指定子项独立复验（2026-11-04）

基线`a17989895` / main `44b66353c`，工作树干净后执行；99d95149a及0982ae65c为main祖先，L16 374914c1d仍exit1。不是在旧源码运行同名测试冒充候选。以下范围为§6已安排的最小复验及其新异步Model2调用差异。

### 后继差异及生产路径

- `d9d4f5569`：`prepared_request.ts:29-44`异步共享prepare按权威协议使用Codex服务，普通供应商先await公开prepareRemoteImages；`provider_requests_service.ts:11-19`提供prepareModel2Async。`index.ts:98-112`注入真实auth并provide requests/Model2服务；`44e7e8a76:model2_streaming_service.ts:64-78`真实await准备→establish→read，不是只有接口定义。对照Rust model2_pipeline.rs:6237-6258异步prepare。旧同步prepareModel2仅剩定义/测试调用，不将其存在误记为当前主流式链仍拒绝Codex。
- `fe2435e5e`追加真实Model2流式入口到同一Codex本地HTTP回归，未删除原single-shot/刷新断言。`:55-61`验证准备url/session/terminal要求，`:62-76`验证old→fresh、仅一次refresh、Model2追加fresh请求与连接命令；`:77-91`验证boundary/RAG/essay/translation及登出状态。
- 证据边界：配置选择的getModel2Config/getTranslationModelConfig被spy固定，独立LlmConfigStore实例显式注入真实auth状态；essay直接构造生产transport，不能称完整用户配置/essay命令全链。两真实provider/manager及本地HTTP没有替换被测sender。
- `completion.ts`与§6请求转换相同，五条raw向量调用生产callRawPrompt，外部fetch是seam；Anthropic实际adapter测试覆盖thinking、去temperature、endpoint保真及Accept。测试没有usage断言，不关闭03父项。
- Anki两条测试通过公开ctx.llmAnkiRouting，真实角色决策和先assignments后configs的best-effort顺序与Rust mod.rs:7734-7749一致；配置读取是seam，L16尚未进入此测试组合。
- 普通路径远程图预取已静态可达，纠正§6“L02 src/index零匹配”旧结论。本轮未执行新增remote-image向量，也未签全部图片消费；OCR `src/ocr_hedge_service.ts:94-99`同步准备与raw usage缺口仍明确存在。

### jobs原始结果

```text
20261104130602-cbcdf4
npx vitest run -c vitest.host.config.ts host/plugins/llm/tests/codex_streaming_integration.test.ts host/plugins/llm/tests/anki_routing_service.test.ts --maxWorkers=1
Test Files 2 passed (2)
Tests 3 passed (3)
Duration 9.64s
原退出码 0

20261104130602-5205b2
npx vitest run -c vitest.host.config.ts host/plugins/llm/tests/model2_pipeline_completion.test.ts -t 'raw_prompt|raw prompt' --maxWorkers=1
Test Files 1 passed (1)
Tests 5 passed | 4 skipped (9)
Duration 5.52s
原退出码 0
```

均经全局job.mjs submit后继续静态审读，再亲取完整result；两份日志均无Errors/Unhandled，首项有WASI ExperimentalWarning，raw WARN为原重试向量输出。4skipped为-t过滤，不是平台skip。完整日志`/home/dsdev/.oc-jobs/done/<job-id>.log`。没有运行Rust、全L02或三平台套件。01/03/08仅上述子项签收，其他父项状态不变；未修改实现/测试/SPEC/TESTMAP。

## 8. OCR共享认证后继main签收与正式依赖失败

`87607ecdc`为OCR真实修复：index.ts向createOcrHedgeService传同一ctx.llmCodexAuth；prepareCandidates改为await prepareProviderRequest（原配置错误仍warn并跳过），runPrepared的isCodex分支使用同一streaming服务。对照原OCR准备/发送流程与§6中明确拒绝Codex的残差，不扩大为整个竞速/取消算法的新验收。

`tests/codex_streaming_integration.test.ts:74-79`新增六行断言，原刷新、Model2、连接、boundary、RAG、translation、logout断言保留。实际调用真实公开llmOcrHedge.prepareCandidates与runPrepared，远端是本地HTTP；没有替换auth/streaming主体。原图像输入是固定data URL，只证明该认证/发送分支，非真实OCR识别质量。

job `20261104131022-87fc5b`完整日志:457-458显示该文件1条实际passed，包含新增OCR向量；同job raw/其他绿不代替用量记录。**整个作业原exit1，2273passed/1failed/3skipped**，唯一失败tokens_command需要tiktoken。F7与C1已确认是正式部署依赖；不使用私有NODE_PATH、替身包或估算降级。该证据只关闭L02-01已列缺陷，02/03等父项仍未决。

当前main新增`16a254adf`门禁按全量基线判断新增失败，但不能改变原测试退出码/业务能力事实。本轮只读用新judgeAgainstBaseline对上述原日志判断：相对全量基线158eaacf1仍为新增失败1项、ok=false。没有修改baseline或selfgate收据；依赖/授权未解前按C1指令不重复全六目录。

## 9. L02-04预算入口局部闭环与原文解码残差

基线review `fc062c667`；预算命令实现/测试来自`8d02f923c`、后继`41e9f134d`，相对既有独立测试基线b70b5e238的budget_commands.ts、budget_commands.test.ts及injection_budget.ts均无差异。当前index.ts:226-228注册真实getConfig/simulate，不是孤立helper；配置存储的get是外部输入接缝，预算算法仍委托F3。

### 已确认子项（不重跑通过测试）

- `budget_commands.ts:23`拒绝六个必填字段缺失；`:61-77`区分读取错误与解析错误、保持命令外层前缀；Rust storage/injection_budget.rs:436-448及commands.rs:6914-6936对应。
- `:81-88`按type→content→priority/source顺序，命令支持七个类型但不支持learner_profile；未知priority回Medium。Rust commands.rs:6938-6983对应。配置本身仍允许LearnerProfile键，与命令支持集合区分正确。
- 独立官方子作业`20261104131022-87fc5b`日志:461-463已实际通过budget_commands两条：{}精确上下文、load错误、默认配置/null boolean拒绝、learner_profile拒绝、优先级线格式及分配结果。该作业整体exit1（唯一tiktoken缺包），不是两个测试失败；这里只复用明确passed结果，不重提专项或整个目录。

### 新残差：恢复部分校验不等于serde全等

`decodeBudget`先JSON.parse，然后用Number.isInteger检查usize。整数词法、64位上界及已知字段重复均未保留。Rust BudgetConfig四处usize（含type_limits值）和derive Deserialize并非这套宽松集合。

只读probe经jobs运行，直接调用生产createBudgetCommands(...).getConfig()，仅settings.get提供原始配置文本，defaultConfig用真实F3 defaultBudgetConfig；未复制被测解码/未写settings/未走完整kernel，证据为E3+TS生产函数探针，不冒充E1或新增E2：

```text
job 20261104142602-d5ed8d，原退出码0，无Errors/Unhandled
integer-looking-float: total_budget:1.0 → accepted:true, total_budget:1
usize-overflow: total_budget:18446744073709551616 → accepted:true, total_budget:18446744073709552000
duplicate-field: total_budget:1,total_budget:2 → accepted:true, total_budget:2
```

三条输入其余字段均为`reserved_for_user_input:0,reserved_for_system:0,type_limits:{},priority_weights:{},enable_smart_truncation:true`。完整node命令和输出在`/home/dsdev/.oc-jobs/done/20261104142602-d5ed8d.log`。exit0表示探针正常打印反例，不是Rust等价测试通过。Rust的usize最大值为18446744073709551615（桌面64位），直接typed serde不接受1.0和已知字段重复。

只保留L02-04原编号，已修子项签收不撤；请owner补对应生产入口向量，修正原文数字/重复字段校验，不通过拒绝合法>2^53值规避D3。此处没有额外推定F3分配算法错误或要求改其实现。root依赖/授权阻塞未解除，未重提六目录门禁。

## 10. D11正式依赖后的原tokens_command单例复验

按C1精确新条件执行，先正常merge main并确认0ed7917b8为祖先。**固定review SHA `3149fdc0f8cf74836d258f144a21f10cffca76e6`，main `0ed7917b8543059dd66dfaa7d45c608a5de9bb25`**；工作区干净。该两提交之间tokens_command.test.ts、tokens.ts、native/tokenizer/index.ts、package.json/package-lock.json无差异，未修改源码/测试来获得通过。

正式D11见decisions.md:163-167；根package.json精确声明tiktoken1.0.22/@node-rs/argon2 2.2.2。此次仅验证tokenizer用例，未运行Argon2算法或将依赖resolve等同功能已验。

```text
job 20261104164359-e55d67
npx vitest run -c vitest.host.config.ts host/plugins/llm/tests/tokens_command.test.ts -t 'estimate_tokens_with_model_short_text_matches_exact_encoding through the command contract' --maxWorkers=1
Test Files 1 passed (1)
Tests 1 passed (1)
Duration 11.31s
原退出码 0，无Errors/Unhandled
```

全局jobs提交后只核D11/版本与实际入口，随后亲取完整result；日志`/home/dsdev/.oc-jobs/done/20261104164359-e55d67.log`。没有额外手动提交六目录或2329集。

测试`tokens_command.test.ts:7-15`经真实Host.invoke('estimate_tokens')进入index.ts:269-270→tokens.ts:72-84→F7 nativeTokenizer.estimateTokensWithModel，`tests/host.ts`注入真实native/tokenizer模块，没有mock算法或fallback。实际断言：['hello world','','<|endoftext|>']得到[2,0,1]/total3；gpt-4o的中文得到3；空texts为0；均precise=true/tokenizer='tiktoken'。这是加载及所选精确编码生产入口证据，不只是require.resolve成功。

历史`20261104162908-9a1f2c`的2329pass/1fail/3skip、原exit1及旧MODULE_NOT_FOUND仍照原记录；此前官方ab8f51de4收据的main既有失败放行也不追溯改成全绿。本次只关闭缺包故障及此指定用例，L02-02整算法/平台范围与其他finding保持原边界。报告提交后按§5官方固定表生成自身tip收据，结果另按原作业退出码报告。

## 11. Linux续作：当前门禁及原finding增量复核（2026-11-05）

固定review `13fd67329` / main `e9df01a3c`。按恢复要求执行三个被验收插件基线，并核对实际源码、TESTMAP；未重做§1–2的18命令/15原测试审读。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm host/plugins/agent-skills
 Test Files  135 passed (135)
      Tests  1654 passed | 1 skipped (1655)
   Duration  258.46s
[作业 20261105000325-ee59c8] 退出码 0
```

按完整文件结果统计，**L02本目录78文件/847passed/0skipped**；llm子串同时选中L01，不将其测试重复归属。完整日志 `/home/dsdev/.oc-jobs/done/20261105000325-ee59c8.log` 无Errors/Unhandled/FAIL；WASI warning保留。`importable: ok`；wiring：`合计 ported 666，其中所测模块未从 index.ts 接入 0（0.0%）`，均exit0。

### 原问题的实际进展

- **06复核确认闭合**：`control.test.ts`8条、`config_store.test.ts`28条实际通过，原始输出明确包含 `logs corrupted policy fallback and failed API configuration saves (L02-06)`、`logs missing profile vendors before skipping them (L02-06)`。独立对照Rust三处warn/error的级别、分支与继续/传播策略，当前源码位置见必须修复区。这里只关闭原日志遗漏，不能将JS解析错误Display当成Rust serde全等。
- **05字段类型子项复核确认**：`config_decode.test.ts`6条通过，包含真实get_model_assignments对数字模型id拒绝、合法null/unknown接受，以及vendor/profile错误字段。旧“数字id直接返回”已过时。`config_values.ts:79-80,135-145`及getModelAssignments仍普通JSON.parse/number；原文重复字段、整数词法/宽度、输入顺序与错误定位仍须修复。例如 `{"model2_config_id":123,"model2_config_id":"ok"}`被先解析后只留末值，不能等同Rust逐键typed解析；这是源码反证，本轮未声称额外探针实跑。
- **03记录调用子项确认，精度仍不通过**：`raw_prompt_service.test.ts`14条通过，其中parse失败与成功两条usage记录有真实生产调用，recorder本身为外部seam。F3 `storage/index.ts:157-165`正式提供llmUsage，旧“F3未发布/raw完全不记录”不再派回。`usage.ts:29-32`对4294967296返回u32MAX，Rust `model2_pipeline.rs:9630-9636`该completion值 `as u32`应为0；普通number解析也不能判断1.0词法。先presence再转换、精确全宽值、真实SQL组合沿原03/V2-02保留。
- **04未闭合**：`budget_commands.ts:17-47`未改变原文JSON.parse/无usize上界；本轮budget_commands两条通过只覆盖原已修缺字段/上下文/命令类型，§9已复现反例仍有效。
- **08消费状态纠偏**：main已包含L16公开路由消费，已不再是缺符号/未合入；本轮只运行本组三插件，未把Anki的完整跨插件组合算作亲跑。
- **02/07边界**：tokens_command本轮再次实际通过，保留§10指定签收。TESTMAP正文666ported/1pending，唯一pending为`:478`Codex bridge；生成头仍24/643，SPEC全局`:71-79`仍空。没有merged/obsolete行需要批准，机械wiring无未接入并不关闭函数/调用链级别证据缺口。

当前未勾选父项为 **02/03/04/05/07/08，共6项**。01既有签收保留，06本轮关闭。架构上本轮所核跨插件调用均经api.ts，usage调用F3所有者而非新写其表；整个应用/平台能力不据此授B。
