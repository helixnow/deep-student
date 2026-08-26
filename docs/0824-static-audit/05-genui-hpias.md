# 05 — GenUI / HPIAS / 技能 静态审计

- 审计基座：`cursor/0824-static-audit-cde6` @ `9f1aa668`（内容即 `origin/cursor/0824-cde6` @ `2d41ea8b` + 本进度仓 README）。
- 对照物：`origin/Generative-UI-0824`（PR #214）tip @ `c2786d4b`、`docs/0824-MERGE-PLAN.md`、`docs/dev/0824-leftover-audit.md`。
- 方法：只读静态审计（git 谱系核对 + 源码/测试逐行核实），未做 Tauri 实机编译，未运行测试。
- 审计人模型：claude-fable-5-thinking-xhigh。

## 1. 加法式 GenUI：#214 整支 tip 不 merge，按文件吸收

**判定：PASS。**

git 谱系实测（本轮 fetch 后复核）：

- `origin/Generative-UI-0824` tip = `c2786d4b`，`merge-base --is-ancestor` 判定**不是** HEAD 祖先——#214 现 tip 从未整支合入。
- Step 1 当时所合的旧 tip `c16a4fbd`（`docs/0824-MERGE-PLAN.md:98`）**是** HEAD 祖先——早期基座合法在树。
- `HEAD..origin/Generative-UI-0824` 恰 30 个独有提交，与 `docs/0824-MERGE-PLAN.md:598`（Step 9 §9.2「#214 全部 30 提交 SKIP」）记录一致。

30 个独有提交的处置可三分对账：

1. **产品加固提交（18 项左右）**：经隔离枝 `0824-leftovers-safe-cde6` 按 patch 重放吸收，即 Step 7 的 merge `362dd2df`（`docs/0824-MERGE-PLAN.md:415-427`）。逐 SHA 处置表在 `docs/dev/0824-leftover-audit.md:22-53`（INCLUDE 24 / ALREADY 6 / DROP 9，无未分类项），其中 GenUI/HPIAS 面全部为 INCLUDE。树上逐项核实见本文第 5 节。
2. **CI 编排提交（8-shard 拆分等）**：明令 DROP，与 A 仓 4 分片相悖（`docs/0824-MERGE-PLAN.md:598`）。
3. **docs 提交（Round 50/62 banner）**：描述 #214 自身树状态，不适用于 0824，SKIP。

对 GenUI/HPIAS 产品面做 `git diff HEAD origin/Generative-UI-0824` 全量比对，仅 9 个文件有差异，逐一核实方向均为「0824 是有意的更强版本」而非漏吸收：

| 文件 | 差异方向 |
| --- | --- |
| `src-tauri/src/chat_v2/tools/generative_ui_executor.rs` | 仅 1 行空行（fmt）差异，语义零差——#214 全部 Rust 加固已在树 |
| `src/features/generative-ui/bridge/hpiasEventBridge.ts` | 0824 为 fail-closed 收紧版（见第 3 节）；#214 tip 反而是弱版 |
| `src/features/generative-ui/utils/dispatchCanvasAIEditRequest.ts` | 0824 护栏文案走 i18n（Step 2 移植 `423dc82a`→`34c66cb2`）；#214 tip 为硬编码中文 |
| `src/features/generative-ui/utils/migrateIntentToV11.ts` | 0824 深拷贝保留加法字段（无损升级，Step 20 `249df98a` 测试锁定）；#214 tip 为丢字段的白名单重建 |
| `handlers/flashcardActionHandlers.ts`、`utils/extractFlashcardsFromIntent.ts`、`utils/buildFlashcardPreviewIntent.ts`、`bridge/resolveGenerativeUIChatActionHandlers.ts`、`index.ts` | #214 tip 仍带闪卡 `save-to-library` 保存链；0824 按 Step 5 只读闪卡裁决**有意不吸收**（`docs/0824-MERGE-PLAN.md:317-325`，入库统一走 `anki_cards` QA/critic 管线），`docs/dev/0824-leftover-audit.md:16-17` 亦明确「没有恢复 save-to-library handler、文案或 locale key」 |

结论：#214 整支 tip 未 merge、可吸收内容已按文件/按 patch 落地、未吸收项均有成文裁决，加法式约束成立。

## 2. GenerativeUiExecutor 注册

**判定：PASS。**

- 注册点：`src-tauri/src/chat_v2/pipeline.rs:347`（`executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()))`）。
- 位置约束「catch-all 前」成立：`ToolPackExecutor` 与兜底 `GeneralToolExecutor` 在 `pipeline.rs:404-411` 的 `Arc::new_cyclic` 中最后注册（`pipeline.rs:408` 注释「GeneralToolExecutor must be last (catch-all)」），347 行早于该块。
- 工具名→块型映射：`pipeline.rs:451`（`"render_generative_ui" => block_types::GENERATIVE_UI`）；Rust 单测 `block_type_mapping_for_render_generative_ui_is_generative_ui`（`generative_ui_executor.rs:493-501`）双向锁定含 `builtin-` 前缀形态。
- 执行器实现：`generative_ui_executor.rs:347-351`（`can_handle` 经 `strip_tool_namespace` 匹配 `render_generative_ui`），`execute` 全链 `emit_start/emit_chunk/emit_end`（424-426 行）。
- HPIAS 接线：`pub mod hpias` 在 `src-tauri/src/lib.rs:67`；executor 在 intent 含 Research 块且带合法 `researchSessionId` 时才 emit `hpias_event` `session_started` 并 spawn 后端（`generative_ui_executor.rs:427-434` 的 `intent_has_research_blocks` 门 + `306-338` 的 `emit_hpias_session_started_if_needed`）。
- 前端契约锁定：`tests/vitest/generative-ui/generativeUiRustMapping.contract.test.ts:162-208`。

## 3. HPIAS session_id 过滤

**判定：PASS（且相对 #214 tip 是收紧，不是放松）。**

三层过滤全部在位：

1. **定向桥 fail-closed**：`src/features/generative-ui/bridge/hpiasEventBridge.ts:106-117`——传入 `sessionId` 的桥对「缺失 `session_id`」「非字符串 `session_id`」「不匹配」三种情况一律丢弃。这是 Step 20 rel-chat `249df98a`（源 `6c9a231f`，`docs/0824-MERGE-PLAN.md:925-929`）的收紧版；#214 tip 同文件为弱版（缺失/非字符串 id 会**穿透**污染定向会话，diff 实测确认）。测试锁定：`tests/vitest/generative-ui/hpiasEventBridge.test.ts:36-51`（按 sessionId 过滤）、`:53-62`（缺失/非法 id fail-closed）。
2. **共享桥 + store 切片路由**：`hpiasEventBridge.ts:134-159` 的 `retainSharedHpiasEventBridge` 进程内单条 `hpias_event` 订阅（多 Chat 研究块只 listen 一次，防事件重复折叠），路由交给 store：`src/stores/researchStore.ts:241-269` 的 `handleEvent` 对外会话事件（含外来 `session_started`）只写入 `sessions[id]` 独立切片（`researchStore.ts:100-101` 多会话切片声明），不覆盖活跃顶层字段；`reset` 保留其它切片（`researchStore.ts:162-183`）。测试锁定：`tests/vitest/generative-ui/hpiasStoreSessionIsolation.test.ts:18/49/67`（忽略异会话 plan、外来 `session_started` 不顶掉活跃会话、reset 不丢其它切片）与 `tests/vitest/generative-ui/hpiasSessionSlice.test.ts`。
3. **事件通道白名单**：`src/utils/guardedListen.ts:27-32` 将 `hpias_event` 收进**精确匹配**集合 `GUARDED_LISTEN_EXACT_NON_CHAT_EVENTS`（非前缀放行）；`tests/vitest/guardedListenAllowlist.test.ts:9-24` 锁定 `hpias_event_private` / `hpias-event` / `prefix_hpias_event` 等仿冒通道不放行。

Rust 侧：`src-tauri/src/hpias/events.rs:31-41` 的 `session_started` payload 构建强制携带 `session_id`（单测 `:59` 断言）；executor 侧 session id 先经清洗（见第 5 节）。

## 4. 恰 18-block allowlist

**判定：PASS，「恰 18」在 Rust 与前端两侧均被测试钉死。**

- **Rust 入口白名单**：`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42` 的 `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 恰 18 项（stat-card / alert / list / progress / action-bar / text / key-value-grid / flashcard-preview / review-calendar / mistake-analysis / mindmap-embed / paper-digest / research-plan / research-report / markdown / chart / steps / table）；`validate_block_types`（`:105-119`）对非对象块、缺 type、未知 type 在入口逐块拒绝。
- **恰 18 的计数断言**：Rust 单测 `parse_intent_accepts_all_registered_block_types` 在 `generative_ui_executor.rs:693-700` 断言 `Some(18)`；未知型/缺型/非对象块的拒绝各有单测（`:640-679`）。
- **前端注册表**：`src/features/generative-ui/blocks/index.ts:37-172` 恰 18 次 `register`；`tests/vitest/generative-ui/generativeUIModuleIntegration.contract.test.ts:23-42` 的 `EXPECTED_BLOCK_TYPES` 恰 18 项，`:114` 用 `toEqual` 做**集合精确相等**（多一个或少一个都红）。
- **跨语言对齐契约**：`tests/vitest/generative-ui/generativeUiRustMapping.contract.test.ts:169-198` 逐项断言 18 个 type 均出现在 Rust 源里且四个拒绝测试存在；`tests/vitest/generative-ui/generativeUISotaAcceptance.contract.test.ts:505` 要求 `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 存在。
- **e2e 行为验收**：`src-tauri/tests/generative_ui_executor_e2e.rs:420-466`（`unknown-widget` 拒绝并回传错误事件）、`:469-474` 起（33 块超 `MAX_GENERATIVE_UI_BLOCKS = 32` 拒绝）。
- **技能/文档同步**：builtin skill 正文逐字列出同一 18 型清单（`src/features/chat/skills/builtin-tools/generative-ui.ts:49`）；`docs/generative-ui/ARCHITECTURE.md:57` 记载一致。

补充边界（非缺陷）：TS Zod 侧允许空 `blocks`（`schema.ts:69` `.min(0)`，用于流式部分态），Rust 入口拒空（`generative_ui_executor.rs:88-90`）；该不对称是成文契约，`generativeUiRustMapping.contract.test.ts:200-208` 专项锁定。

## 5. leftovers-safe GenUI/HPIAS 加固（24 项 INCLUDE）

**判定：PASS。** `docs/dev/0824-leftover-audit.md:22-53` 的 INCLUDE 表逐项在树核实：

| 加固项 | 树上证据（路径:行号） |
| --- | --- |
| 完整 intent 256k 上限 | `generative_ui_executor.rs:21`（`MAX_GENERATIVE_UI_INTENT_CHARS = 256_000`）、`:66-77` 双态（原始串/重序列化）校验 |
| 流式 buffer 256k 上限 + 稳定错误码 | `src/features/generative-ui/utils/streamBufferGuard.ts:6-8`（`MAX_GENERATIVE_UI_STREAM_CHARS = 256_000`、`STREAM_BUFFER_CAPPED_WARNING`）；`parser.ts:353-354`、`schema.ts:213/361`、`GenerativeUIRenderer.tsx:115/143` 消费 |
| noteEdit 256 KiB 上限 | Rust `generative_ui_executor.rs:191-211`；TS `utils/extractNoteEditPayload.ts:8`（`256 * 1024`）双侧对齐 |
| noteEdit 字段白名单 | `generative_ui_executor.rs:213-228`（仅 operation/content/search/replace/section 重建，异型值拒绝） |
| noteEdit 禁 regex 转发 HITL | `generative_ui_executor.rs:187-189`（`isRegex == true` 直接拒）；`dispatchCanvasAIEditRequest.ts:52-56` 前端二道防（绕过 extract 的直调也过 `noteEditPayloadSchema`） |
| researchSessionId 清洗（TS+Rust） | Rust `generative_ui_executor.rs:143-167`（≤128、首字符字母数字、仅 `._-`）；TS `utils/extractResearchSessionId.ts:5-13`（等价正则）；`schema.ts:61` 在 Zod 层 transform 清洗 |
| 文本叶清洗进 props 校验 | `schema.ts:10/237`（`sanitizeGenerativeTextLeaves` 前置于 safeParse）；`utils/sanitizeGenerativeText.ts:15-31` |
| URL / markdown 清洗（style/srcdoc/ping/background） | `utils/sanitizeGenerativeMarkdown.ts:44-47`（属性剥离 + href/src/ping/background 等 URL 属性重写）、`utils/sanitizeGenerativeUrl.ts:54`（scheme allowlist） |
| HPIAS 并发会话切片 + 外会话隔离 + 外来 session_started 隔离 | `researchStore.ts:100-101/241-269`（见第 3 节） |
| Style Lab reset 保留其它切片 | `researchStore.ts:162-183`（`reset` 只重建目标切片，`sessions` 合并保留）；`hpiasStoreSessionIsolation.test.ts:67` |
| 单一 HPIAS listener | `hpiasEventBridge.ts:134-159`（引用计数共享订阅 + `:162-165` 测试重置钩子） |
| undo 栈隔离 | `GenerativeUIRenderer.tsx:248`（每个 Renderer 实例 `useMemo(() => new GenerativeActionUndoStack(), [])` 独立栈，`:427` 注入 ActionBar）；栈上限 20（`handlers/actionUndoStack.ts:13`） |
| Rust ingress 18 块白名单 + e2e 拒未知型 | 见第 4 节 |
| apply-note-edit 强制配 noteEdit | `generative_ui_executor.rs:232-252/398-412` |

INCLUDE 表其余项（matchMedia 测试设置、build 堆、CI 修复等）不属本报告分区，留给 09 号报告对账。

## 6. 技能「生成式界面」入口

**判定：PASS。**

- 技能定义：`src/features/chat/skills/builtin-tools/generative-ui.ts:9-22`（`id: 'generative-ui'`、`isBuiltin: true`、`allowedTools: ['builtin-render_generative_ui']`），embedded tool JSON Schema `:86-155`（blocks `maxItems: 32`、noteEdit `additionalProperties: false` 且 search 注明「不支持正则表达式」、researchSessionId 说明与顶层优先级）。
- 注册入口：`src/features/chat/skills/builtin-tools/index.ts:35`（导出）、`:144`（进入 `builtinToolSkills` 注册数组）。
- 中文名「生成式界面」：`src/locales/zh-CN/skills.json:395`（`"generative-ui": "生成式界面"`），描述 `:450`；英文对应 `src/locales/en-US/skills.json:395/450`。此为 Step 15 落地的 `414abdc7`（`docs/0824-MERGE-PLAN.md:747-756`）。
- 测试锁定：`src/features/chat/skills/__tests__/builtinSkillLocalization.test.ts:19-28`（每个内置技能双语必须有显示名）与 `:34-40`（专项钉死 generative-ui 的 name+description 双语非空），即 Step 17 回收的 `54da9c33`。
- 技能内容与后端契约同步：`tests/vitest/generative-ui/generativeUiSkill.contract.test.ts:92`（正文必须含 `MAX_GENERATIVE_UI_BLOCKS`）；技能规则 `generative-ui.ts:68`（Research 块必须带 researchSessionId、无合法 id 不订阅 hpias_event）、`:69`（闪卡仅展示、禁保存 action——与 Step 5 只读闪卡裁决一致）。

## 7. 禁止削弱 HPIAS

**判定：PASS——本树相对 #214 tip 与合并前基线只紧不松。**

- 定向桥由「缺失 id 穿透」改为 fail-closed（第 3 节第 1 条），diff 方向实测为 0824 更强；`hpiasEventBridge.test.ts:53-62` 把 fail-closed 钉成回归红线，任何回退该行为的改动会红。
- `guardedListen` 对 `hpias_event` 从前缀式放行收敛为精确匹配集合（`guardedListen.ts:27-32/46`），`guardedListenAllowlist.test.ts:14-18` 锁定仿冒通道不得放行——Step 20 记录「guardedListen 白名单只紧不松」（`docs/0824-MERGE-PLAN.md:928`）。
- HPIAS allowlist 行为测试（Step 20 `71a51913`，源 `8e6d8e8f`）已在 `generativeUIModuleIntegration.contract.test.ts` 生效：`:114` 的集合精确相等使白名单增删均显式化。
- Rust 侧 HPIAS 管线未被触碰削弱：`src-tauri/src/hpias/mod.rs:1-23` 模块面完整（events/orchestrator/payloads/retrieval_backend/service/synthesis）；executor 启动研究会话仍要求「Research 块存在 + 合法 session id」双门（`generative_ui_executor.rs:427-434`），且 `sanitize_research_session_id` 未放宽。
- 18 项不变量清单第 14 项（HPIAS 会话隔离 + 18 块白名单）自 Step 9 起每步收口均复查为 PASS（`docs/0824-MERGE-PLAN.md:626`，最近一次 Step 17/`:825-833`）；本轮独立复核与其一致。
- 无削弱旁证：`git log` 中全部 HPIAS 相关提交（`362dd2df`、`249df98a`、`71a51913` 及 leftovers-safe 各 SHA）改动方向均为隔离/拒收/测试锁定，无任何放宽 allowlist、放宽 session 校验或移除过滤的提交。

## 8. 观察项（不降级，无需产品修复）

1. `guardedListen` 的白名单断言仅在 dev（`import.meta.env.DEV`）生效（`guardedListen.ts:59-64`），生产构建不拦截——这是全仓既有设计（dev assert 门），非本轮引入，与 HPIAS 无特异性；如需生产强门可另立议题。
2. `generativeUiRustMapping.contract.test.ts:169-198` 对 Rust 白名单是「18 项都必须在」的下界断言，理论上 Rust 单侧新增第 19 型不会被该契约拦截；但 Rust 单测 `:699` 的 `Some(18)` 计数与前端 `toEqual` 精确集合已分别封死两侧，实际漂移会在各自测试暴露。仅记录，无需动作。
3. `normalizeHpiasEventPayload`（`hpiasEventBridge.ts:76-87`）仅校验 `type` 为字符串即断言为 `HpiasEvent`；session 维度的严格校验由桥过滤与 store 切片承担（第 3 节），当前测试覆盖充分。

## 结论

**PASS。**

- #214 整支 tip（`c2786d4b`）确未 merge（非 HEAD 祖先），30 个独有提交按「leftovers-safe 逐 patch 吸收 / CI 编排 DROP / docs SKIP」三分处置完毕，产品面 9 个残余 diff 均为 0824 有意的更强或成文裁决的不吸收（只读闪卡）。
- `GenerativeUiExecutor` 在 catch-all 前注册（`pipeline.rs:347`），块型映射与 HPIAS 接线完整。
- HPIAS `session_id` 过滤三层在位（定向桥 fail-closed、store 外会话切片、事件通道精确白名单），且相对 #214 tip 为收紧方向。
- 18-block allowlist 恰 18，Rust 计数断言（`Some(18)`）与前端集合精确相等双侧钉死，e2e 覆盖未知型与 33 块拒绝。
- leftovers-safe 的 GenUI/HPIAS 加固（256k/256KiB 上限、noteEdit 白名单与禁 regex、researchSessionId 双侧清洗、文本/URL/markdown 清洗、会话与 undo 栈隔离、单一 listener）逐项在树。
- 技能「生成式界面」入口（定义、注册、双语词条、本地化测试）齐备。
- 未发现任何削弱 HPIAS 的改动；全部相关提交方向为隔离/拒收/测试锁定。

不需要产品修复。**本轮不改代码**——本报告为只读静态审计，仅新增本 markdown 文件，未触碰任何产品代码、测试或配置。
