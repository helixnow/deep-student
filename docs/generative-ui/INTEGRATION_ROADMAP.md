# Generative UI 模块集成路线图

> 合并 Round 1 子代理 #4 / #7 / #8 结论

## 学习模块（#4 题库 / Anki / Learning Hub）

| 场景 | blocks | action handlers |
|------|--------|-----------------|
| 复习概览 | stat-card + progress + list | `start-review` → `fsrsReviewStore.startDueSession` |
| 错题诊断 | mistake-analysis + list | `open-qbank` → qbankDriver |
| 闪卡预览 | flashcard-preview（已落地） | 只读展示；保存统一走 `anki_cards` QA/critic 管线 |

**原则**：不重写 `anki_cards` 专用块；generative-ui 只做轻量摘要与展示入口。

## Research / Translation（#7）

| 建议块 | 协议 | 状态 |
|--------|------|------|
| `paper_digest` | NDJSON 快照（参照 `paperSave.tsx`） | ✅ generative-ui `paper-digest` 块 POC |
| `research_report` | 流式 markdown + citation `[类型-N]` | ✅ generative-ui `research-report` 块 POC |
| `research_plan` | 映射 HpiasStore 事件词汇表 | ✅ generative-ui `research-plan` 块 POC + **HpiasStore 实时接线** Round 14 |

**原则**：rAF 批处理 + 终态 `toolOutput` 双通道；引用走 `BackendSourceInfo` / `Block.citations`。

| 场景 | 落点 | 状态 |
|------|------|------|
| 翻译会话简报 | `TranslationContentView` | ✅ Round 15 |
| 流式翻译简报 | `translationStreamBridge` + `streamKey` | ✅ Round 17 |
| HPIAS Chat 实时研究 | `generative_ui` 块 + `hpias_event` | ✅ Round 16 |
| Research action handlers | `copy-report` / `export-plan` Chat+HPIAS | ✅ Round 18 |
| 全模块 integration contract | mount/bridge/handler 静态验证 | ✅ Round 19 |
| Rust HPIAS emit POC | `hpias::HpiasEventEmitter` + executor 接线 | ✅ Round 20 |
| Rust HPIAS pipeline orchestrator | `HpiasPipelineOrchestrator` + payloads 生命周期 | ✅ Round 21 |
| HPIAS 可替换后端 + 运行时验收 | `HpiasResearchBackend` + lifecycle contract + runtime test | ✅ Round 22 |
| 14 块全量 runtime + Chat HPIAS E2E | `generativeUIAllBlocksRuntime` + `generativeUIChatBlockHpiasRuntime` | ✅ Round 23 |
| VFS retrieval HPIAS backend | `RetrievalHpiasResearchService` + env `retrieval` | ✅ Round 24 |
| HPIAS LLM synthesis | `hpias/synthesis.rs` + Model2 Markdown 综合 | ✅ Round 25 |
| SOTA acceptance contract | 15 项集成要求静态验收 | ✅ Round 20 |
| 18 块 + Intent v1.1 + telemetry + fallback | markdown/chart/steps/table + coercePartialIntent + undo | ✅ Round 40/41 |
| 18 块宿主接线 | Exam/Memory/Index/Hub/Notes/Translation/HPIAS/Dashboard builders | ✅ Round 41 |
| 渲染隔离 + Markdown 消毒 | `GenerativeBlockSlot` + `sanitizeGenerativeMarkdown` | ✅ Round 41 |
| Rust v1.1 version/layout | executor 契约 + e2e（拒 `"2"`、透传 grid） | ✅ Round 41 |
| compact / i18n / testid / migrateToV11 | 移动端密度、词条合同、选择器合同、v1→v1.1 | ✅ Round 42 |
| action 守卫 / lint / JSON Schema | timeout + rate-limit + live region + URL 消毒 | ✅ Round 45 |

## 安全 / HITL（#8）

| riskLevel | UX | 状态 |
|-----------|-----|------|
| low | 直接执行 | ✅ |
| medium | 二次点击确认 | ✅ |
| high | `DsAlertDialog` | ✅ |
| 有效级别 | `max(模型, handler)` | ✅ |
| AI 标记 | `AiContentLabel` | ✅ |

## Workbench（#5 仪表盘）

| 场景 | 落点 | 状态 |
|------|------|------|
| AI 学习简报 widget | `DesktopAgendaWidget` 同级 | ✅ |
| Chat generative_ui 块 | blockRegistry + eventRegistry | ✅ |
| AI 仪表盘应用窗口 | 新 `AppDefinition` + agentManifest | ✅ Round 13 |

## 流式管道（#9）

| 项 | 状态 |
|----|------|
| Rust SSE → Tauri 事件 → chunkBuffer | 既有 Chat V2 管道 |
| `plugins/events/generativeUI.ts` | ✅ |
| 块级增量 parser（闭合 block 提交 + last-good） | ✅ |
| 后端 emit `generative_ui` 事件 | ✅ |

## Notes（#3）

| 项 | 规范 |
|----|------|
| 首选宿主 | `NotesContextPanel` 只读摘要 |
| 写入 | 仅 `canvas:ai-edit-request` + OCC |
| 全文 | `getFullMarkdown()` / DSTU |
| 新块 | Round 41 已接 markdown / table 等（见 `buildNoteSummaryIntent`） |
| 详情 | `NOTES_INTEGRATION.md` |

## Round 42–45（本地完成）

Round 42–44 补洞与体验加固已收口。Round 45 增加 action timeout / rate-limit / live region、forced-colors/print、URL 消毒、intent lint、JSON Schema 导出、稳定 block id、locale 数字与 telemetry ring。

Round 63：HPIAS `sessions[sessionId]` 切片保活并发研究；未注册 ActionBar 不再渲染模型文案。
Round 64：Chat 共享一条 `hpias_event` 订阅；Markdown 剥 `style`/`srcdoc`。
Round 65：`reset` 保活其它会话切片；Style Lab 不再全量 `clear`；mindmap embed ID 白名单。
Round 66：强制 handler 注册表时不渲染未注册 ActionBar 按钮。
Round 67：无可见操作时不输出空 toolbar。
Round 68：全未登记 ActionBar 不渲染 skip-to-actions。
Round 69：每个 Renderer 独立 HITL 撤销栈。
Round 70：skip-to-actions 落到第一个可达 ActionBar 槽位。
Round 72：Markdown 消毒 `ping`/`background`；宿主简报去掉 defaultValue。
Round 73：外会话 `session_started` 不顶活跃会话；流式也订阅 HPIAS；引用 note。

不改 Goal 为 complete；合入 main 仍 ⏳。
