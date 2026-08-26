# 36 - cardAgent.startGeneration 生产入口审计

- 审计对象：`cardAgent.startGeneration` 的生产调用链路，及 `ChatV2AnkiAdapter` 退役残留核查
- 对照基线：`origin/cursor/0824-cde6`（本分支相对基线在下列源文件上零差异，仅新增 docs）
- 审计方式：纯静态阅读，不运行代码

## 1. startGeneration 本体

位置：`src/components/anki/cardforge/engines/CardAgent.ts`（约 411-440 行）。

行为核实：

1. **非阻塞直启**：校验 `content` 非空 → `buildBackendGenerationOptions(input)` 组装选项 → `invoke('start_enhanced_document_processing', ...)` → 启动成功即返回 `{ ok: true, documentId }`，不注册卡片收集器、不等待 `DocumentProcessingCompleted`。
2. **不依赖事件监听初始化**：与 `generateCards` 不同，不调用 `waitForReady()`，因此即使 `CardAgent` 构造期的 `anki_generation_event` 监听设置失败也不影响启动；进度由任务台（anki-tasks，基于 `get_document_tasks` / `anki_generation_event`）跟踪，与注释声明一致。
3. **选项装配与 generateCards 共用** `buildBackendGenerationOptions`：模板列表（`template_ids` + `template_descriptions` + 兼容回退 `template_id`）、字段提取规则（单模板 `field_extraction_rules` / 多模板 `*_by_id`）、`custom_anki_prompt`（PromptKit system prompt）两条路径契约完全一致，无分叉。
4. **错误路径闭环**：模板为空 / invoke 抛错均返回 `{ ok: false, error }`，不抛出到调用方之外。
5. **后端入口共用**：`start_enhanced_document_processing` 即 `EnhancedAnkiService::start_document_processing`，与 ChatAnki `chatanki_start` 管线共用，注释与实现相符。

## 2. 生产调用图（src/ 非测试代码，穷尽枚举）

`cardAgent.startGeneration(` 在生产代码中仅有两个直接调用点，均为共享服务层：

| 直接调用点 | 上游生产表面 |
| --- | --- |
| `src/features/chat/services/selectionCardGeneration.ts`（聊天/PDF 划词制卡，附 `set_document_session_source` 会话回链） | `src/features/chat/components/MessageItem.tsx`、`src/features/pdf/selectionStudyActions.ts`、`src/features/pdf/components/PdfSelectionActions.tsx` |
| `src/features/anki/generateCardsFromText.ts`（通用文本制卡共享入口） | `src/features/notes/generateCardsFromNote.ts`、`src/components/ReviewQuestionsView.tsx`（错题本）、`src/components/EssayGradingWorkbench.tsx`（作文批改） |

两个服务层入口行为对称：内容长度下限校验（均为 10 字符）→ `startGeneration` → 成功弹「已开始」通知并提供跳转任务台动作；失败弹错误通知并返回结构化 `{ ok: false, reason, error }`。聊天内制卡（ChatAnki `builtin-chatanki_*` 工具）为纯后端管线，不经过 `CardAgent`，与本入口无重叠。

阻塞式 `generateCards` 无任何 UI 生产调用方，仅测试覆盖（`tests/vitest/anki/cardforge/CardAgent.test.ts`），与文件头注释声明一致。

## 3. ChatV2AnkiAdapter 残留核查

- **无模块文件**：`src/` 下不存在任何名称含 `ChatV2AnkiAdapter` 的文件；无任何 `import`/动态 `import()` 引用。
- **出现位置仅两类**：(a) 历史说明注释（`CardAgent.ts`、`cardforge/index.ts`、`selectionCardGeneration.ts`、`generateCardsFromText.ts`）；(b) 防复活守卫测试——`src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts` 断言各制卡表面走 `cardAgent.startGeneration(` 且 src/ 全树无同名模块文件、无同名 import；`src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts` 对 PDF 表面另有同类断言。
- **配套桥接同步删除**：`CardAgent` 不再监听 `anki_tool_call`（源码核实仅监听 `anki_generation_event` 一个后端事件），与「Chat V2 工具桥随 AnkiToolExecutor 退役整体删除」的注释一致。

## 4. 对照基线差异

`git diff origin/cursor/0824-cde6...HEAD` 显示 `CardAgent.ts`、`selectionCardGeneration.ts`、`generateCardsFromText.ts` 三个源文件零差异；本分支相对基线仅新增 `docs/0824-static-audit/` 下的审计文档（30 files, 4345 insertions, 全部为 docs）。本次审计结论完全适用于基线分支。

## 结论

- `cardAgent.startGeneration` 是划词/文本制卡的唯一前端生产入口，非阻塞语义、选项装配契约（与 `generateCards` 共用 `buildBackendGenerationOptions`）、错误闭环均与注释声明一致；生产调用图收敛在两个共享服务层（聊天/PDF 划词 + 通用文本入口），六个上游表面全部经由它们，无旁路链路。
- `ChatV2AnkiAdapter` 已彻底退役：无模块文件、无 import，仅存于历史注释与两组防复活守卫测试，桥接事件 `anki_tool_call` 监听同步移除。
- 相对 `origin/cursor/0824-cde6` 相关源文件零差异，未发现需要修复的问题。**本轮不改代码**。
