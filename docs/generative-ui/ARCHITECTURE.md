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
```

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

## 7. 测试

- vitest：`tests/vitest/generative-ui/`（registry / parser / handlers / contract）
- Rust：`generative_ui_executor` 单元 + e2e（需 Cargo ≥ edition2024 环境）

进度详见 [PROGRESS.md](./PROGRESS.md)
