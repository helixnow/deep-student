# Generative UI 架构方案（DeepStudent）

> 分支：`Generative-UI-0824` · Round 9+ 持续迭代中

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
├── utils/                 # build*Intent + dispatchCanvasAIEditRequest
├── blocks/index.ts        # 14 种内置块（import 即注册）
└── components/
```

## 3. 内置块（14 种）

`stat-card`, `alert`, `list`, `progress`, `action-bar`, `text`, `key-value-grid`, `flashcard-preview`, `review-calendar`, `mistake-analysis`, `mindmap-embed`, `paper-digest`, `research-plan`, `research-report`

## 4. Human-in-the-loop

| 层级 | 机制 |
|------|------|
| ActionBar | `riskLevel` low/medium/high + handler 注册表安全模式 |
| Notes 写入 | `canvas:ai-edit-request` → AIDiffPanel → Accept/Reject |
| 闪卡保存 | `save-to-library` → `saveCardsToLibrary`（chat/anki 管线） |
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

**`hpias::HpiasResearchBackend`**（Round 22）通过 `StubHpiasResearchService` 封装 orchestrator，executor 经 `create_research_backend` 启动 pipeline；前端 `contracts/hpiasLifecycleContract.ts` 与 Rust payloads 跨语言对齐。未来真实 HPIAS 后端实现同一 trait 即可替换 stub。

关键文件：
- `src/features/chat/plugins/blocks/generativeUI.tsx`
- `src/features/chat/plugins/events/generativeUI.ts`
- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs`

## 6. 集成状态（Round 9）

| 模块 | 状态 |
|------|------|
| Chat generative_ui 块 | ✅ |
| 流式 parser + chunkBuffer | ✅ |
| Notes 摘要 + HITL 写入 | ✅ |
| Learning Hub 简报（Exam/Memory/IndexStatus） | ✅ |
| Workbench DesktopAiBriefingWidget | ✅ |
| Workbench AiDashboardAppWindow + agentManifest | ✅ Round 13 |
| mindmap-embed E2E | ✅ |
| prompt props 同步 | ✅ |
| 闪卡 save-to-library | ✅ Round 10 |
| Research/Translation 专用块 | paper-digest + research-plan + research-report POC ✅ |
| HpiasStore 实时接线 | `HpiasGenerativeResearchPanel` ✅ Round 14 |
| Hpias Chat 事件桥 | `hpiasEventBridge` + Chat 块挂载 ✅ Round 16 |
| Research action handlers | `copy-report` / `export-plan` ✅ Round 18 |
| Translation 会话简报 | `TranslationGenerativeBriefing` ✅ Round 15 |
| Translation 流式简报 | `translationStreamBridge` + streamKey ✅ Round 17 |

## 7. 测试

- vitest：`tests/vitest/generative-ui/`（registry / parser / handlers / contract / **runtime**）
- Rust：`generative_ui_executor` 单元 + hpias 模块（需 Cargo stable + Linux GTK CI）
- SOTA 清单：[SOTA_CHECKLIST.md](./SOTA_CHECKLIST.md)

进度详见 [PROGRESS.md](./PROGRESS.md)
