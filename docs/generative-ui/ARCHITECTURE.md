# Generative UI 架构方案（DeepStudent）

> 分支：`Generative-UI-0824` · Round 41/42（18 块已接宿主；R42 补洞进行中）

## 1. 核心结论

DeepStudent 的生成式 UI 模式是 **结构化意图 + 组件注册表**：

- 模型只输出 JSON（`blocks[]`），描述 `type` + `props`
- 应用侧 `generativeUIRegistry` 映射到已验证的 shadcn/设计系统组件
- Zod schema 校验，不合法拒绝或降级
- 副作用（提交、删除、导出、保存闪卡、笔记写入）由确定性 `actionHandlers` 执行，模型不直接执行

## 2. 模块结构

```
src/features/generative-ui/
├── schema.ts              # Zod 意图 + props schema
├── registry.ts            # 组件注册表 + prompt catalog（含 propsHint）
├── parser.ts              # 流式 JSON 增量解析 + GenerativeUIStreamParser 状态机
├── GenerativeUIRenderer.tsx
├── GenerativeUIChrome.tsx
├── prompts.ts             # 系统 prompt 模板
├── bridge/
│   ├── chatBlockBridge.ts
│   ├── generativeUIStreamRegistry.ts
│   ├── hpiasEventBridge.ts      # hpias_event → HpiasStore
│   └── resolveGenerativeUIChatActionHandlers.ts
├── handlers/              # workbench / notes / flashcard action handlers
├── utils/                 # build*Intent + dispatchCanvasAIEditRequest + sanitizeGenerativeMarkdown
├── blocks/index.ts        # 18 种内置块（import 即注册）
└── components/            # 含 GenerativeBlockSlot / GenerativeUIErrorBoundary
```

宿主简报（Round 41 已接线）：Exam / Memory / IndexStatus / LearningHub / Notes / Translation / HPIAS / AiDashboard 的 `build*Intent` 已纳入 table / chart / steps / markdown，并可输出 v1.1 `layout.mode=grid`。

### Intent v1.1 layout

- `version` 为 `'1' | '1.1'`，缺省仍为 `'1'`；v1 文档（无 `layout`）继续合法
- v1.1 可选顶层 `layout: { mode: 'stack' | 'grid', columns?: 1|2|3 }`
- 块级可选 `span?: 1|2|3`（仅 grid 下映射到 `sm:col-span-*`），非法值钳制到 1–3
- Renderer：`stack` 保持 `grid gap-3` 单列；`grid` 按 columns 加 `sm:grid-cols-2` / `sm:grid-cols-3`，并写 `data-layout-mode` / `data-layout-columns`
- 未知 version（如 `'2'`）：`parseGenerativeUIIntent` 失败；流式 parser 降级为 v1 last-good blocks（layout 未闭合时同样保留已提交块）

### 渲染隔离与消毒（Round 41）

- 块级隔离：`GenerativeBlockSlot`（`React.memo`）包一层 `GenerativeUIErrorBoundary`；单块抛错不拖垮整页，槽位挂 `data-generative-block="<type>"` / `data-block-type`
- Markdown 消毒：`sanitizeGenerativeMarkdown` 在进入 Chat `MarkdownRenderer` 前剥 script / on* / 危险标签（围栏代码原文保留）；与 `rehype-sanitize` defaultSchema 对齐
- 流式坏 JSON：`coercePartialIntent` + last-good blocks，非整页报错（`data-stream-fallback`）

### Rust v1.1 契约（Round 41）

`generative_ui_executor::parse_intent`：

- `version` 缺省视为 `"1"`；仅允许 `"1"` / `"1.1"`；拒绝 `"2"` 等未知值
- `layout.mode` 识别 `stack` | `grid`；未知 mode 不拒绝整份 intent（前端钳制）
- `blocks[].type` 必须落在 18 种内置白名单（`ALLOWED_GENERATIVE_UI_BLOCK_TYPES`）；未知 / 缺 type / 非对象块在入口拒绝
- e2e：`execute_v1_1_grid_layout_emits_generative_ui` + `execute_rejects_version_2`

## 3. 内置块（18 种）

`stat-card`, `alert`, `list`, `progress`, `action-bar`, `text`, `key-value-grid`, `flashcard-preview`, `review-calendar`, `mistake-analysis`, `mindmap-embed`, `paper-digest`, `research-plan`, `research-report`, `markdown`, `chart`, `steps`, `table`

## 4. Human-in-the-loop

| 层级 | 机制 |
|------|------|
| ActionBar | `riskLevel` low/medium/high + handler 注册表安全模式 |
| Notes 写入 | `canvas:ai-edit-request` → AIDiffPanel → Accept/Reject |
| 闪卡预览 | `flashcard-preview` 只读展示；保存、QA/critic 与审计统一由 `anki_cards` 管线负责 |
| AI 标记 | `GenerativeUIChrome` + `AiContentLabel` |

## 5. Chat 桥接

```
Rust render_generative_ui
  → generative_ui 事件（start/chunk/end）
  → eventBridge chunkBuffer
  → block.content + toolOutput.intent
  → extractGenerativeUIIntent(blockId)
  → GenerativeUIRenderer + resolveGenerativeUIChatActionHandlers
  → （可选）researchSessionId / Research 块 → hpias_event → HpiasGenerativeResearchPanel
```

Hpias 实时研究（Round 16）：
- Tauri `hpias_event` → `startHpiasEventBridge` → `HpiasStore.handleEvent`
- Chat `generative_ui` 块在 `researchSessionId` 或 intent 含 research 块时挂载 `HpiasGenerativeResearchPanel`
- 会话激活后静态 research 块由实时面板取代，避免重复渲染

Translation 流式简报（Round 17）：
- `useTranslationStream({ publishKey: resourceId })` → `translationStreamBridge`
- `TranslationGenerativeBriefing` 通过 `streamKey={node.id}` 订阅，翻译进行中实时更新 progress / copy 文本

### HPIAS 后端 emit 协议（Round 19 约定）

前端 `hpiasEventBridge` 订阅 Tauri 通道 **`hpias_event`**。后端应按以下约定 emit（payload 为 HpiasEvent JSON，或 `{ event: HpiasEvent }` 包装）：

| 字段 | 说明 |
|------|------|
| `type` | 事件类型（必填），与 `HpiasEvent` 联合类型一致 |
| `session_id` | 研究会话 ID；Chat 块可通过 `researchSessionId` 过滤 |
| `round` | 轮次（plan/retrieval/synthesis 类事件） |

关键生命周期：`session_started` → `plan_generated` → `retrieval_completed` → `selection_completed` → `subagent_*` → `synthesis_updated` → `session_completed`。

Rust **`hpias::HpiasEventEmitter`**（Round 20）在 `render_generative_ui` 携带 `researchSessionId` 时 emit `session_started`，激活前端 HPIAS 桥。

**`hpias::HpiasPipelineOrchestrator`**（Round 21）在 intent 含 Research 块时于后台按生命周期 emit：`plan_generated` → `retrieval_completed` → `selection_completed` → `subagent_*` → `synthesis_updated` → `session_completed`（payload 构建见 `hpias/payloads.rs`，与 Style Lab 演示时间线对齐）。

**`hpias/synthesis.rs`**（Round 25）在 retrieval 后端完成 VFS 检索后，经 Model2 生成 Markdown 研究报告（`generate_synthesis_with_llm`）；LLM 失败时回退确定性 `build_synthesis_markdown`。

关键文件：
- `src/features/chat/plugins/blocks/generativeUI.tsx`
- `src/features/chat/plugins/events/generativeUI.ts`
- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs`

## 6. 集成状态（Round 41/42）

| 模块 | 状态 |
|------|------|
| Chat generative_ui 块 | ✅ |
| 流式 parser + chunkBuffer | ✅ |
| Notes 摘要 + HITL 写入 | ✅ 已接 markdown / table 等新块（Round 41） |
| Learning Hub 简报（Exam/Memory/IndexStatus） | ✅ table/chart/steps/markdown + v1.1 grid（Round 41） |
| Workbench DesktopAiBriefingWidget | ✅ |
| Workbench AiDashboardAppWindow + agentManifest | ✅ Round 13；Round 41 接入新块 |
| mindmap-embed E2E | ✅ |
| 18 块宿主接线 | Exam/Memory/Index/Hub/Notes/Translation/HPIAS/Dashboard ✅ Round 41 |
| 渲染隔离 + Markdown 消毒 | `GenerativeBlockSlot` + `sanitizeGenerativeMarkdown` ✅ Round 41 |
| Rust Intent v1.1 | version/layout 契约 + e2e ✅ Round 41 |
| 18 块 + v1.1 layout E2E | Playwright CT + [TAURI_E2E.md](./TAURI_E2E.md) ✅ Round 41 |
| prompt props 同步 | ✅ few-shot / skill 18 type（Round 41） |
| 闪卡预览 | ✅ 只读展示；无独立保存管线 |
| Research/Translation 专用块 | paper-digest + research-plan + research-report POC ✅ |
| HpiasStore 实时接线 | `HpiasGenerativeResearchPanel` ✅ Round 14；Round 41 接入新块 |
| Hpias Chat 事件桥 | `hpiasEventBridge` + Chat 块挂载 ✅ Round 16 |
| Research action handlers | `copy-report` / `export-plan` ✅ Round 18 |
| Translation 会话简报 | `TranslationGenerativeBriefing` ✅ Round 15；Round 41 接入新块 |
| Translation 流式简报 | `translationStreamBridge` + streamKey ✅ Round 17 |
| compact / i18n / testid / migrateToV11 | ✅ Round 42 |
| action timeout / rate-limit / live region | ✅ Round 45 |
| URL 消毒 / intent lint / JSON Schema | ✅ Round 45 |
| prefers-contrast / skip-to-actions / parse codes / Style Lab lint | ✅ Round 46 |

## 7. 测试

- vitest：`tests/vitest/generative-ui/`（registry / parser / handlers / contract / **runtime** / isolation / sanitize，含 18 块 smoke）
- Playwright CT：`tests/ct/generative-ui/` — 18 块 smoke（含 markdown/chart/steps/table）+ v1.1 layout 可选检查
- Rust：`generative_ui_executor` 单元（含 v1.1 version/layout）+ hpias 模块（需 Cargo stable + Linux GTK CI）
- SOTA 清单：[SOTA_CHECKLIST.md](./SOTA_CHECKLIST.md)（Round 42–45 本地收口；合入 main 仍 ⏳）
- Tauri E2E：[TAURI_E2E.md](./TAURI_E2E.md)（18 块 + v1.1 layout 手动/CT 步骤）

进度详见 [PROGRESS.md](./PROGRESS.md)
