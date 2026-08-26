# Generative UI 进度日志

## Wrap-up（2026-08-24）— 收尾审查与修复

CI `32704302688` 仍 queued，**本轮不 push**。早期并行 `cursor/*` 分支的独立功能已由主线 refined 实现覆盖，**不再 merge 旧 tip**（避免回退）。

1. [x] ActionBar 展示 trusted handler label，阻断模型伪装
2. [x] Prompt / skill / Rust `maxBlocks` 对齐 32
3. [x] 流式 256k cap、同长内容替换、无 id 恢复切片、last-good persist
4. [x] skip-link `useId`、Chrome 流式回落不卸载、ActionBar live 重复播报
5. [x] Style Lab 取消过期 timer；showcase `demo-action` 注册
6. [x] URL 消毒改为 scheme allowlist，拦截空白/控制字符混淆与 SVG data
7. [x] parser 不再把 meta 字符串 `"blocks"` 当成 blocks 数组
8. [x] handler 查找 `Object.hasOwn`；无 registry 时仍派发 `onAction`
9. [x] 宿主 handler 标签可 i18n；Chat 转发 `researchSessionId` / copy 标签
10. [x] leftover 分支覆盖确认 + 本地门禁
11. [x] 0824 合并裁决：移除 Generative UI 闪卡独立保存入口，保留只读预览；入库统一走 `anki_cards` QA/critic 管线

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 49（2026-08-24）— 10 子代理：快照 diff / 流式 / HPIAS

CI `32704302688` 仍 queued，**本轮不 push**。

1. [x] Style Lab 与上一快照 diff
2. [x] `useGenerativeUIStream` errorCodes + 成功快照
3. [x] last-good persist 写入 fingerprint
4. [x] Steps / List / Table `dir=auto`
5. [x] HPIAS copy-intent 接线
6. [x] Renderer 块级 `data-block-error-codes`
7. [x] Few-shot 研究例加入 copy-block
8. [x] Rust e2e 拒绝 33 块
9. [x] Mindmap / Chart `dir=auto`
10. [x] 文档与测试收口

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 48（2026-08-24）— 10 子代理：Chat 接线 / Rust 32 / 宿主 i18n

CI `32704302688` 仍 queued，**本轮不 push**。

1. [x] Chat resolve 接入 copy-block + 通用 export-intent
2. [x] Rust `MAX_GENERATIVE_UI_BLOCKS = 32`
3. [x] Mistake analysis locale
4. [x] Review calendar locale + `formatGenerativeDate`
5. [x] Alert / StatCard / Flashcard `dir=auto`
6. [x] Renderer 未注册 action 提示
7. [x] Paper digest dir + citation locale
8. [x] Rust mapping 合同 32
9. [x] Style Lab lint 按已注册 action id 门禁
10. [x] Research plan dir + locale

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 47（2026-08-24）— 10 子代理：locale / skill / 引用键盘

CI `32704302688` 仍 queued，**本轮不 push**。

1. [x] Renderer parse-error codes + intent snapshot
2. [x] Chart tooltip locale
3. [x] List 空态 i18n
4. [x] KeyValueGrid 数字 locale
5. [x] Progress 数字 locale
6. [x] Research citation 键盘激活
7. [x] `copy-block` handler
8. [x] Skill maxBlocks 12→32 + JSON Schema 约束
9. [x] Style Lab fingerprint
10. [x] Chrome `stream_done` 播报

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 46（2026-08-24）— 10 子代理：可观测 / 对比度 / 导出

CI `32704302688`（head `af00a73c`）仍 queued，**本轮不 push**。

1. [x] ActionBar live 区分 timeout / rate-limit
2. [x] prefers-contrast hook + CSS + `data-contrast`
3. [x] Text/Markdown `dir="auto"`
4. [x] Table 数字 locale 格式化
5. [x] Renderer fingerprint + skip-to-actions + `data-block-id`
6. [x] System prompt 注入 JSON Schema type enum
7. [x] Intent snapshot ring（最近 20）
8. [x] `classifyGenerativeUIParseErrors` 稳定 code
9. [x] Style Lab lint 面板
10. [x] `export-intent` Markdown 剪贴板 handler

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 45（2026-08-24）— 10 子代理：守卫 / 导出 / a11y

在 Round 44 之上并行 10 项。旧 CI `32701178039` 已被后续 push 取消；新 run `32704302688`（head `af00a73c`）仍 queued，**本轮其余提交不 push**。

1. [x] action timeout — `wrapActionWithTimeout`（15s）编入 instrumentation
2. [x] action rate-limit — `wrapActionWithRateLimit`（400ms + in-flight）
3. [x] ActionBar live region — `aria-live` + `data-action-unregistered`
4. [x] forced-colors / print — 系统色焦点环 + 打印藏 chrome
5. [x] URL 消毒 — `sanitizeGenerativeUrl`（markdown 复用）
6. [x] intent lint — `lintGenerativeUIIntent`
7. [x] JSON Schema 导出 — `exportGenerativeUIJsonSchema`（18 type enum）
8. [x] 稳定 block id — `assignStableBlockIds`（Renderer + normalize `assignIds`）
9. [x] locale 数字 — StatCard `formatGenerativeStatValue`
10. [x] telemetry ring — 最近 50 条 + instrumentation 默认写入

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 44（2026-08-24）— 10 子代理：SOTA 体验加固

在 Round 43 之上并行 10 项（**本地完成，未 push**，保护 CI `32701178039`）：

1. [x] 禁裸 px 合同 — `fontSizeToken.contract.test.ts`（引用徽标改 `text-xs`）
2. [x] overflow UX — `data-blocks-truncated` + i18n
3. [x] intent fingerprint — 稳定 16 hex + 可选 telemetry
4. [x] 文本字段消毒 — `sanitizeGenerativeText` 进 `validateBlockProps`
5. [x] 明暗主题合同 — `themeToken.contract.test.ts`
6. [x] focus-visible — `--ring` 语义环
7. [x] intent diff — `diffGenerativeUIIntent`
8. [x] 新块流式 parser — markdown/chart/steps/table last-good
9. [x] recipe i18n — Style Lab `demo.recipes.*`
10. [x] SOTA 文档对齐（不标 Goal complete）

- [x] generative-ui vitest **606** 全绿

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 43（2026-08-24）— 10 子代理：SOTA 契约加固

在 Round 42 之上并行 10 项（**本地完成，未 push**，保护 CI `32701178039`）：

1. [x] `buildIntentExportMarkdown` — 18 type 文本导出
2. [x] `prefers-reduced-motion` — Chrome / Progress / `data-reduced-motion`
3. [x] `normalizeGenerativeUIIntent` 宿主 API
4. [x] 语义色合同（禁裸 hex）
5. [x] `copy-intent` clipboard action
6. [x] 流式 buffer 256KB 硬上限（保留 last-good）
7. [x] Chart 减动画（reduced-motion / compact）
8. [x] research `export-intent` 宿主接线
9. [x] compact 间距 4/8/12 token（`.generative-ui-compact`）
10. [x] SOTA 文档对齐（不标 Goal complete）

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 42（2026-08-24）— 10 子代理：SOTA 补洞

在 Round 41 已落地「18 块接宿主 + 隔离 + 消毒 + v1.1 Rust」之上并行 10 项（已本地完成，**未 push** 以免 cancel CI `32701178039`）：

1. [x] 移动端 compact（窄屏强制 stack）
2. [x] `migrateToV11`（v1 → v1.1 兼容升级）
3. [x] i18n 完整合同（zh-CN / en-US 243 key 对齐）
4. [x] 宿主新块测试（Exam/Memory/Index/Hub/Notes/Translation/HPIAS/Dashboard）
5. [x] ActionBar 键盘可达（方向键 / Esc / Undo）
6. [x] 18 块 `data-generative-block` 合同
7. [x] Chat 块新 type 路径（markdown/chart/steps/table）
8. [x] Widget 回归（DesktopAiBriefing chart/table）
9. [x] last-good 可选 persistKey 持久化
10. [x] SOTA 文档补洞 + `useMediaQuery` matchMedia 空值防护

- [ ] 合入 main — 待 CI + 批准（仍 ⏳，Goal 未 complete）

## Round 41（2026-08-24）— 10 子代理：宿主接入 + 隔离 + 契约

并行 10 个足量任务，把 Round 40 的 18 块接到真实宿主并加固：

1. Hub 简报（Exam/Memory/Index/LearningHub）接入 table/chart/steps/markdown + v1.1 grid
2. Notes / Translation / HPIAS / AiDashboard 接入新块
3. Style Lab：6 套 intent recipes + 18 块 Showcase
4. Markdown XSS 消毒 + ErrorBoundary
5. few-shot / skill 扩到 18 type（+3 正例 +2 负例）
6. Renderer 块级 memo + 错误隔离（`GenerativeBlockSlot`）
7. Rust v1.1 version/layout 契约 + e2e 用例
8. CT / TAURI_E2E 14→18 块
9. 新块 a11y（region / img / caption / scope=col）
10. SOTA 验收合同对齐真实态

- [x] **390** generative-ui vitest 全绿（Round 40 为 344）
- [ ] 合入 main — 待 CI + 批准

## Round 6（2026-08-24）

### 父代理
- [x] `buildExamBriefingIntent` + `ExamGenerativeBriefing` — ExamContentView 题库简报 POC（stats + handleStartReview）
- [x] `createExamBriefingActionHandlers` — 上下文回调注入（start-review / open-practice）
- [x] `buildNoteSummaryIntent` labels/i18n 注入（对齐其他 builder 模式）
- [x] Memory/IndexStatus Hub 挂载点（IndexStatusView + MemoryView + MemoryFolder）
- [x] `buildIndexStatusBriefingIntent` / `buildMemoryBriefingIntent` + 上下文 action handlers
- [x] actionHandlerSync contract 扩展（exam / index / memory）
- [x] generative-ui skill ↔ Rust parse_intent contract 测试
- [x] Rust execute 级测试（`generative_ui_executor` 单元 + `generative_ui_executor_e2e`；本环境 Cargo 1.83 暂无法跑通 `cargo test`）
- [x] generativeUiRustMapping contract（context/pipeline 双映射）
- [x] 78 项 vitest 全绿（含 Hub 组件 + Rust mapping contract）

### Round 7（2026-08-24）

- [x] mindmap-embed E2E — `GenerativeUIRenderer` 全链路（解析 → registry → lazy embed 渲染 + 流式 partial + 校验失败）
- [x] Notes 写入 HITL 链 — `dispatchCanvasAIEditRequest` + `createNotesEditActionHandlers` + `buildNoteEditSuggestionIntent`
- [x] actionHandlerSync contract 扩展（note edit suggestion）
- [x] generativeUi i18n（notes.edit_* 词条）
- [x] 93 项 generative-ui vitest 全绿

## Round 40（2026-08-24）— 10 子代理足量推进

并行 10 个子代理，每包含实现 + 测试 + i18n/文档接线：

1. **markdown (P1)** — Chat `MarkdownRenderer` + builder + 8 tests
2. **chart (P2)** — recharts bar/line/pie + 17 tests
3. **steps (P2)** — 学习计划步骤 5 态 + Learning 接线
4. **table (P2)** — shad Table 列 schema + builder
5. **Intent v1.1** — stack/grid + span，v1 兼容；Rust/skill 同步
6. **telemetry + undo** — HITL 可观测 / 可撤销栈（上限 20）
7. **a11y** — 14 原有块 landmark / progressbar / live region + 宪法 §8
8. **prompt few-shot** — 4 正例 + 5 负例 + skill 同步
9. **简报升级** — Exam/Memory/Index/Hub/Dashboard/Notes/HPIAS/Translation 全量加块
10. **流式恢复** — `coercePartialIntent` + last-good + 流式 fallback（非整页报错）

父代理接线：18 块写入 `blocks/index.ts` + fixture/contract/skill。

## Round 39（2026-08-24）— 15min timer 复查（06:00 UTC）

- [x] timer `generative-ui-ci-recheck` 触发复查
- [ ] run `32694690653`（head `ae015334`）— 12 jobs 仍 **queued**（~36min+，updatedAt 未变）
- [x] 仓库最近 30 条 run **0** 条 in_progress/success（infra 全局阻塞）
- [x] PR #214：`MERGEABLE` / `BLOCKED`，无 review comment
- [x] 本地 `tsc --noEmit` 通过
- **策略**：不 push（避免 cancel 排队 run）；45min timer 仍待触发；CI 分支订阅仍活跃

## Round 34（2026-08-24）— 仓库 CI 全局排队

- [x] migration 静态 gate + build config contracts 51/51 本地通过
- [ ] CI run `32693778400`（head `7694c6f7`）— 12 jobs **queued**（~8min+，仓库最近 20 条 run 无 in_progress/success）
- **策略**：不 push，等待 runner 分配；已订阅 CI 通知

## Round 33（2026-08-24）— Pod 恢复 + 本地 gate 复验

- [x] 环境恢复：`npm ci` 后全 gate 复验通过（tsc / lint 0 err / licenses / fmt / vite build / 210 vitest）
- [x] 推送 `7694c6f7`；新 run `32693778400` 触发（旧 run `32691393068` 取消）

## Round 32（2026-08-24）— CI 等待 + 本地全 gate 复验

- [x] commit `13585efd` 本地 gate 全绿：tsc / lint(0 err) / licenses / fmt / vite build / 210 generative-ui vitest
- [x] vitest 4 分片本地模拟启动（shard 1/4 运行中）
- [ ] PR #214 CI run `32689455852` — 12 jobs 持续 **queued**（GitHub runner 排队，非代码问题）
- **策略**：本轮不再 push，避免 cancel 正在排队的 run

## Round 31（2026-08-24）— Frontend licenses:check

- [x] 预检发现 `package-lock.json`（Round 1 添加 zod 生产依赖）未同步 `THIRD_PARTY_NOTICES.txt`
- [x] `npm run licenses:generate` 重新生成（1872 components，含 zod@4.4.3）
- [x] `npm run licenses:check` 通过

## Round 30（2026-08-24）— Backend fmt 修复

- [x] `cargo fmt --check` 预检发现 generative_ui / hpias Rust 格式未对齐
- [x] `cargo fmt` 修复 9 个文件（Backend CI 阻塞项）
- [x] 本地 migration 静态 gate + build config contracts 51/51 通过

## Round 29（2026-08-24）— CI 就绪复验

- [x] 本地 gate：`tsc --noEmit` / `vite build` / 210 generative-ui vitest 全绿
- [x] ESLint：`parseResearchReportCitations` 正则无用转义 + `AIDiffPanel` hooks 顺序修复
- [ ] PR #214 CI 结果（Round 28 push 后仍 queued）

## Round 28（2026-08-24）— CI tsc 修复

- [x] `ai-dashboard/register.ts` → `register.tsx`（JSX 扩展名）
- [x] **22 项 tsc 错误清零** — discriminated union 类型守卫、Finder breadcrumbs、MemoryIcon import、ActivationDispatchResult 对齐
- [x] `schema.ts` 增加 `isGenerativeUIParseFailure` / `isBlockPropsValidationFailure`
- [x] 210 项 generative-ui vitest + tsc `--noEmit` 全绿

## Round 27（2026-08-24）— Goal 收尾

- [x] 最终验收：210 项 generative-ui vitest 全绿
- [x] PR [#214](https://github.com/helixnow/deep-student/pull/214) 转 **Ready for Review**
- [x] SOTA_CHECKLIST 增加 Goal 完成度审计表
- [ ] 合并 main（待 CI + 人工 approve）

## Round 26（2026-08-24）

- [x] **Rust Tauri E2E** — `generative_ui_executor_e2e.rs` hpias_event `session_started` + stub `plan_generated`
- [x] **`TAURI_E2E.md`** — 自动化 / vitest / 手动 / Playwright CT 验收指南
- [x] **Playwright CT** — `tests/ct/generative-ui/hpiasResearchPanel.spec.tsx`
- [x] **`generativeUITauriE2E.contract.test.ts`** — Tauri E2E 静态验收
- [x] SOTA_CHECKLIST 标记 Tauri E2E 完成

## HPIAS honesty fix（2026-08-26）

- [x] Chat 默认禁用 HPIAS 动态 pipeline，研究块只渲染静态 intent；`stub` 仅可显式启用
- [x] retrieval 依赖不可用时 fail closed，不再静默回退演示 stub
- [x] Rust plan queries 与前端同样封顶 12 并去重；修复 stub citation id 格式化
- [x] `research-report` 复用安全的 Chat MarkdownRenderer

## Round 25（2026-08-24）

- [x] **`hpias/synthesis.rs`** — `generate_synthesis_with_llm`（Model2 Markdown + 90s 超时）
- [x] `build_synthesis_llm_prompt` — 检索证据 → LLM prompt；失败回退确定性拼接
- [x] `retrieval_backend` 接线 LLM synthesis
- [x] contract / SOTA_CHECKLIST 更新

## Round 24（2026-08-24）

- [x] **`hpias/retrieval_backend.rs`** — `RetrievalHpiasResearchService` 经 `VfsUnifiedRetriever` 真实检索
- [x] `HpiasResearchDeps` — executor 注入 vfs_db / lance_store / llm_manager
- [x] `DEEP_STUDENT_HPIAS_BACKEND=retrieval` 后端（VFS 不可用时由 Round 26 改为 fail closed）
- [x] 确定性 `build_synthesis_markdown`（LLM 综合待续）
- [x] contract / SOTA / ARCHITECTURE 更新

## Round 23（2026-08-24）

- [x] **`allBlocksFixture.ts`** + **`generativeUIAllBlocksRuntime.test.tsx`** — 14 块全量运行时渲染 SOTA 验收
- [x] **`generativeUIChatBlockHpiasRuntime.integration.test.tsx`** — Chat 块 + 真实 `useHpiasEventBridge` + mock Tauri listen 全链路
- [x] **`HpiasBackendKind`** — `DEEP_STUDENT_HPIAS_BACKEND` 环境变量扩展点（Round 26 改为默认禁用）
- [x] **`SOTA_CHECKLIST.md`** — 目标态验收清单与剩余项
- [x] SOTA acceptance 扩展 all-blocks / chat-hpias / checklist 要求
- [x] vitest 全绿

## Round 22（2026-08-24）

- [x] **`hpias/service.rs`** — `HpiasResearchBackend` trait + `StubHpiasResearchService`（可替换真实后端）
- [x] `generative_ui_executor` 经 `create_research_backend` 启动 pipeline（不再直接调用 orchestrator）
- [x] **`hpiasLifecycleContract.ts`** — Rust/TS 跨语言生命周期事件契约
- [x] **`hpiasPayloadParity.contract.test.ts`** + **`hpiasPipelineRuntime.integration.test.ts`** — 渐进式运行时验收
- [x] SOTA acceptance 扩展 service / lifecycle / runtime 要求
- [x] vitest 全绿

## Round 21（2026-08-24）

- [x] **`hpias/payloads.rs`** — HpiasEvent 生命周期 payload 构建器（plan/retrieval/subagent/synthesis/completed）
- [x] **`hpias/orchestrator.rs`** — `HpiasPipelineOrchestrator` 后台 emit pipeline（对齐 Style Lab 时间线）
- [x] `generative_ui_executor` — researchSessionId + Research 块 → session_started + spawn orchestrator
- [x] `.cargo/config.toml` — 移除强制 `-fuse-ld=lld`，CI 可通过 `RUSTFLAGS` 可选启用
- [x] SOTA / Rust mapping contract 扩展 orchestrator 验收
- [x] vitest 全绿；Rust `cargo test` 本环境仍受 edition2024 依赖版本限制

## Round 20（2026-08-24）

- [x] Rust **`hpias::HpiasEventEmitter`**（Round 20）+ executor `session_started` emit
- [x] **`generativeUISotaAcceptance.contract.test.ts`** — 15 项 SOTA 集成要求静态验收
- [x] Rust mapping contract 扩展 hpias emit 接线验证
- [x] 175 项 vitest 全绿；Rust `cargo test` 本环境 linker（`-fuse-ld=lld`）仍不可跑通，靠源码 + contract 验证

## Round 19（2026-08-24）

- [x] **全模块 integration contract** — `generativeUIModuleIntegration.contract.test.ts`（14 块 / bridge / handler / mount 点）
- [x] `hpiasEventBridge.integration.test.ts` — Style Lab 时间线 → dashboard intent + action-bar 全链路
- [x] `resolveGenerativeUIChatActionHandlers` — Research `export-plan` 覆盖 workbench handler 测试
- [x] Rust mapping contract 扩展 `researchSessionId`
- [x] ARCHITECTURE HPIAS 后端 emit 协议约定

## Round 18（2026-08-24）

- [x] **Research action handlers** — `createResearchBriefingActionHandlers`（`copy-report` / `export-plan`）
- [x] `buildResearchExportMarkdownFromSnapshot` + `extractResearchContentFromIntent` 导出工具
- [x] `buildHpiasResearchDashboardIntent` 追加 action-bar；Hpias 面板 + Chat resolve 接线
- [x] Research 上下文 `export-plan` 覆盖 workbench handler（剪贴板导出 Markdown）
- [x] i18n `research.actions.*` + vitest + 文档更新

## Round 17（2026-08-24）

- [x] **流式翻译简报** — `translationStreamBridge` + `useTranslationStream({ publishKey })`
- [x] `mergeTranslationBriefingMetrics` — session 与流式快照合并
- [x] `TranslationGenerativeBriefing` 订阅 `streamKey`（node.id）实时更新进度
- [x] `buildTranslationBriefingIntent` 支持 `isStreaming` + `streaming_progress_title` i18n
- [x] vitest + ARCHITECTURE / INTEGRATION_ROADMAP 更新

## Round 16（2026-08-24）

- [x] **Hpias Tauri 事件桥** — `hpiasEventBridge.ts` + `useHpiasEventBridge`（`hpias_event` → HpiasStore）
- [x] Chat `generative_ui` 块挂载 `HpiasGenerativeResearchPanel`（`researchSessionId` / Research 块触发）
- [x] `extractResearchSessionId` + 静态 Research 块去重（live 会话激活后 omit）
- [x] `render_generative_ui` skill / Rust executor 可选 `researchSessionId` 参数
- [x] `guardedListen` 白名单 `hpias_event`
- [x] vitest + ARCHITECTURE / INTEGRATION_ROADMAP 更新

## Round 15（2026-08-24）

- [x] **Translation 模块 Generative UI 集成** — `buildTranslationBriefingIntent` + `TranslationGenerativeBriefing`
- [x] `TranslationContentView` 挂载 AI 翻译简报（语向/进度/术语表 + 设置/复制译文 actions）
- [x] `createTranslationBriefingActionHandlers` — `translation:openSettings` + clipboard
- [x] i18n `translation.briefing.*` + actionHandlerSync contract

## Round 14（2026-08-24）

- [x] **HpiasStore → Generative UI 实时接线** — `mapHpiasStoreToResearchPlanSteps` + `buildHpiasResearchDashboardIntent`
- [x] `HpiasGenerativeResearchPanel` — 订阅 store，渲染 research-plan + stat-card + research-report
- [x] Style Lab **Research HPIAS** 演示模式 — `playStyleLabHpiasDemo` 事件时间线
- [x] i18n `research.hpias.*` + vitest 桥接/面板测试

## Round 13（2026-08-24）

- [x] Workbench **AI 仪表盘应用窗口** — `AiDashboardAppWindow` + `AppDefinition` + `agentManifest`
- [x] `buildAiDashboardIntent` — 学习简报 + 制卡任务 stat-card / action-bar 扩展
- [x] `workbenchLearningHandlers` 扩展 `open-task-dashboard`
- [x] i18n（workbench.dashboard.* / apps.aiDashboard）
- [x] vitest：buildAiDashboardIntent / AiDashboardAppWindow / aiDashboardAgentManifest

## Round 12（2026-08-24）

- [x] `research-report` 块 — 流式正文 + `[type-N]` 引用 badge 渲染
- [x] `parseResearchReportCitations` + `buildResearchReportIntent`
- [x] Research/Translation #7 三路 POC 齐备（paper-digest / research-plan / research-report）
- [x] 121 项 generative-ui vitest 全绿

## Round 11（2026-08-24）

- [x] Research POC — `paper-digest` + `research-plan` 块组件与 registry 注册
- [x] `buildPaperDigestIntent` / `buildResearchPlanIntent` 确定性 builder（labels i18n 注入）
- [x] generativeUi research.* i18n 词条（zh-CN / en-US）
- [x] builderI18n contract — 所有 build*Intent 必须支持 labels
- [x] researchBlocks E2E 测试 + skill/registry catalog 同步
- [x] 117 项 generative-ui vitest 全绿

## Round 10（2026-08-24）

- [x] 闪卡 `save-to-library` action handler — `createFlashcardSaveActionHandlers` → `saveCardsToLibrary`
- [x] `buildFlashcardPreviewIntent` + `extractFlashcardsFromIntent` 工具
- [x] `resolveGenerativeUIChatActionHandlers` 扩展闪卡 handlers + Chat 块 blockId/session 上下文
- [x] ARCHITECTURE.md 全面更新（Round 9 架构态）
- [x] generativeUIArchitectureContract 扩展 bridge 层验证
- [x] INTEGRATION_ROADMAP 更新（闪卡/Rust emit ✅）
- [x] 112 项 generative-ui vitest 全绿

## Round 9（2026-08-24）

- [x] Rust `GenerativeUiExecutor` noteEdit 校验（parse_note_edit + apply-note-edit 必填 gate）
- [x] Rust 单元测试：noteEdit 透传 / 缺失 noteEdit 失败
- [x] generative_ui_executor_e2e：noteEdit input 保留
- [x] Style Lab `GenerativeUIDemoTab` 扩展 — 笔记 HITL / 导图嵌入 / 流式四模式
- [x] generativeUiSkill + Rust mapping contract 扩展 noteEdit
- [x] 106 项 generative-ui vitest 全绿

## Round 8（2026-08-24）

- [x] Chat `generative_ui` 块挂载 actionHandlers — `resolveGenerativeUIChatActionHandlers`（modeState.canvasNoteId + toolInput.noteEdit）
- [x] prompt sync — `schemaToPromptHint` + catalog props 摘要注入 system prompt
- [x] builtin skill 扩展 `noteEdit` 参数 + apply-note-edit 规则
- [x] 测试：generativeUIChatBlock / resolveGenerativeUIChatActionHandlers / registryPromptSync props（102 项 vitest 全绿）

### Round 6+
- [x] chunkBuffer 增量流式状态机（`GenerativeUIStreamParser` committedBlocks + `generativeUIStreamRegistry`）
- [x] eventBridge `generative_ui` chunk 走 chunkBuffer；onEnd/onError flush + finalize
- [x] `generativeUI.tsx` 传入 blockId 驱动增量解析
- [x] 测试：parser.stateMachine / streamRegistry / eventBridge generative_ui chunkBuffer（101 项 vitest 全绿）

---

## Round 5（2026-08-24）

### 父代理
- [x] Rust `GenerativeUiExecutor` + `render_generative_ui` 工具（emit generative_ui 事件）
- [x] `block_types::GENERATIVE_UI` + `event_types::GENERATIVE_UI`
- [x] `buildAIDiffSummaryIntent` + AIDiffPanel 确定性变更摘要头
- [x] `LearningHubGenerativeBriefing` POC（finderStore 数据源）
- [x] 40 项 vitest 全绿
- [x] Round 5 子代理跟进：P0 i18n 块组件、actionHandlerSync 契约、learningHubActionHandlers、简报去重 meta
- [x] Round 5 子代理调研合并（Round 6 路线图见上）
- [x] `render_generative_ui` builtin skill + 历史 toolInput.intent 恢复 + ActionBar HITL

### Round 5 子代理结论摘要
| 主题 | 状态 |
|------|------|
| 流式 parser P0 | ✅（tryParsePartialIntent + chunkBuffer + streamRegistry 状态机） |
| mindmap-embed | ✅（schema + E2E renderer 全链路） |
| prompt sync | ✅（目录行 + props schema 摘要进 prompt） |
| Learning Hub 挂载 | Exam / Memory / IndexStatus ✅ |
| i18n | ✅（块组件 + builder labels 注入 + builderI18n contract） |
| Security HITL | ✅（ActionBar + Notes dispatch 链 + Chat 块挂载；OCC 终态落盘仍走 AIDiffPanel） |
| Rust emit | ✅（execute + noteEdit 校验；本环境 Cargo 1.83 暂无法跑通 cargo test） |

---

## Round 4（2026-08-24）

### 父代理
- [x] `DesktopAiBriefingWidget` — 桌面 AI 学习简报（todo + 闪卡数据源）
- [x] `workbenchLearningHandlers` — workbenchBus 接线
- [x] `mindmap-embed` 块（React.lazy + MindMapEmbed）
- [x] `registryPromptSync` contract 测试
- [x] 38 项 vitest 全绿（generative-ui + DesktopAiBriefingWidget）

---

## Round 3（2026-08-24）

### 父代理
- [x] `NotesGenerativeSummary` — NotesContextPanel 只读摘要 POC
- [x] `buildNoteSummaryIntent` 确定性意图构建
- [x] Style Lab `GenerativeUIDemoTab` 演示页签
- [x] `learningActionHandlers` 学习 action 注册表
- [x] generative-ui i18n（zh-CN / en-US）
- [x] 组件 i18n 化（Renderer / Chrome / Panel / ActionBar）

### 下一轮（Round 4）
- Workbench `AiBriefingWidget` 桌面 widget
- Rust 后端 `generative_ui` 事件 emit
- `mindmap-embed` 块
- schema↔registry↔prompts 三处同步 contract

---

## Round 2（2026-08-24）

### 父代理
- [x] `useGenerativeUIStream` hook
- [x] `GenerativeUIPanel` Copilot 面板壳
- [x] 学习专用 blocks：flashcard-preview, review-calendar, mistake-analysis
- [x] Chat `generative_ui` 块桥接
- [x] 新增测试 useGenerativeUIStream + chatBlockBridge

### Round 2 安全层（#8 跟进）
- [x] `resolveEffectiveRiskLevel` — handler 权威 riskLevel
- [x] high → `DsAlertDialog`；medium → 二次点击
- [x] `GenerativeUIChrome` 复用 `AiContentLabel`
- [x] `INTEGRATION_ROADMAP.md`（#4/#7/#8）

### Round 1 子代理结论（已合并 7/10）

| # | 子代理 | 要点 | 跟进 |
|---|--------|------|------|
| 1 | [Chat 块注册表](bc-78a45f92-2d86-5c9c-bfe1-4bdc37dc8710) | 双注册表桥接 | ✅ |
| 2 | [设计系统审计](bc-d88c5979-bb89-5636-b38c-2c62f473436b) | 设计宪法 | ✅ |
| 4 | [题库与学习 Hub](bc-e423e9d9-9643-528c-8da2-f68f80c71d22) | store 结构化；action handlers | 📋 路线图 |
| 6 | [Mindmap 注册表](bc-b0635482-e1a3-5f0b-bae0-7301e62d59f2) | mindmap-embed | 📋 Round 4 |
| 7 | [Research/翻译](bc-966855a0-2513-5a99-84b7-54a95cc31d41) | NDJSON + HpiasStore | 📋 路线图 |
| 8 | [安全/HITL](bc-d50a51fa-aa8a-543f-9079-e3928b3a3729) | 三级确认 | ✅ |
| 3 | [Notes 生成式集成](bc-770ae86e-b50a-58e0-be31-80efbcad0e93) | ContextPanel 只读；写入走 canvas | ✅ `NOTES_INTEGRATION.md` |
待合并：无 — Round 1 **10/10** 子代理已全部合并

### Round 1 总览（10 × claude-fable-5-thinking-xhigh）

| 主题 | 结论 |
|------|------|
| 架构 | 双注册表 + Zod + `generative_ui` chat 桥接（已实现） |
| 设计系统 | token 作宪法；间距/字号子集约束 |
| 学习模块 | store 结构化高；action → qbank/fsrs/anki 管线 |
| Workbench | 桌面 widget / 应用窗 Copilot（Round 3+） |
| Mindmap | `mindmap-embed` 引用式（Round 4） |
| Research | NDJSON + HpiasStore 块类型 |
| 安全 | handler 权威 riskLevel + DsAlertDialog |
| 流式 | eventRegistry + 块级 parser |
| Notes | 只读面板优先；写入走 canvas 建议通道 |
| 测试 | contract + schema + renderer 三层 |

### 子代理（Round 1）
| # | 状态 |
|---|------|
| 1–10 | ✅ 全部合并 |

### 下一轮计划（Round 3）
- 合并 Round 1 子代理调研结论
- Notes / Learning Hub 集成 POC
- Style Lab 演示页挂载 GenerativeUIDemo
- 流式 parser 增强 + a11y post-processing

---

## Round 1（2026-08-24）

### 父代理
- [x] 创建分支 `Generative-UI-0824`
- [x] 创建 Goal：Generative-UI-0824 多轮 SOTA 迭代
- [x] 实现 `src/features/generative-ui/` 核心模块
  - schema（Zod）、registry、parser、renderer、chrome
  - 7 个内置块：stat-card, alert, list, progress, action-bar, text, key-value-grid
- [x] 添加 `zod` 直接依赖
- [x] 架构文档 ARCHITECTURE.md

### 子代理（10 × claude-fable-5-thinking-xhigh，Round 1/20+）
| # | 任务 | 状态 |
|---|------|------|
| 1 | Chat blockRegistry 分析 | ✅ 已合并 |
| 2 | 设计系统审计 | ✅ 已合并 |
| 3 | Notes generative 集成 | 进行中 |
| 4 | 题库 / Anki / Learning Hub | 进行中 |
| 5 | Workbench 仪表盘 | 进行中 |
| 6 | Mindmap Registry 复用 | 进行中 |
| 7 | Research / Translation | 进行中 |
| 8 | 安全 / Human-in-the-loop | 进行中 |
| 9 | AI 流式输出模式 | 进行中 |
| 10 | 测试契约模式 | ✅ 已合并（见 Round 2 测试补全） |

### 下一轮计划（Round 2）
- 合并 Round 1 子代理结论到本文档
- Chat Copilot 面板 POC
- 扩展 learning 专用 blocks（review-calendar, flashcard-preview）
- contract tests + vitest 覆盖

---

_本文件随每轮迭代更新并提交 PR。_
