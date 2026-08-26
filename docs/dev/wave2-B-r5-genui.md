# 0824 Wave2-B 第 5 轮 — Agent 结合-2（GenUI 只读子应用入口）

- 角色：本轮 `src/features/generative-ui/**` 独占写手。
- 约束遵守：未运行 npm / vitest / tsc / cargo（全部验证为静态读码 + grep 干跑）；未 commit / push（父代理统一处置）。
- 任务：给 GenUI 只读块补「打开已有资源」的子应用入口（打开笔记锚点、打开 PDF 页），**保持 GenUI 不可写**（无 save / create 副作用）。
- 对照：`docs/generative-ui/NOTES_INTEGRATION.md` 写入规约（禁止 handler 直写后端）、台账「GenUI 只读冻结：只做只读增量」不变量（wave2-B-ledger §18 不变量第 8 条）。

---

## 一、改动清单

| # | 文件 | 性质 |
|---|---|---|
| 1 | `src/features/generative-ui/handlers/openResourceActionHandlers.ts` | **新增**。只读导航 handler 工厂 + 组合 action id + 强校验 + dispatch |
| 2 | `src/features/generative-ui/utils/buildOpenResourceEntryBlock.ts` | **新增**。确定性 action-bar 入口块构建（宿主 append 用） |
| 3 | `src/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers.ts` | **修改**（+~45 行）。chat 侧自动注册 `open-note:` / `open-pdf-page:` 前缀 action |
| 4 | `src/features/generative-ui/index.ts` | **修改**。导出新模块符号 |
| 5 | `tests/vitest/generative-ui/openResourceActionHandlers.test.ts` | **新增**（用例文本，未执行；新文件名零冲突，域归属 generative-ui） |
| 6 | 本文档 | 新增 |

禁改区自查：`FlashcardPreviewBlock.tsx`、`buildFlashcardPreviewIntent`、anki 相关、`tool_loop` / `coordinator.rs`、`buildHpiasResearchDashboardIntent`（HPIAS 18-block 结构）全部 **零 diff**；`git diff --stat` 除上述 3+1 文件外无其它触碰。

## 二、设计：复用两条既有只读导航契约，零新事件

不造新事件、不加后端调用，两类入口各骑一条现成消费链：

### 打开笔记（含标题锚点）

```
GenUI ActionBar 按钮点击
  → dispatchOpenNoteNavigation({ noteId, heading? })
      ├─ heading 有值：publishNotesHeadingTarget({noteId, heading})
      │    （notes headingTargetBridge 冷启动 pending map，编辑器挂载后
      │      consume 一次即清——与 [[Note#Heading]] wikilink 跳转同机制、
      │      同规范化，宿主无关）
      └─ window.dispatchEvent('DSTU_OPEN_NOTE',
           { noteId, source: 'generative-ui', heading? })
```

`source: 'generative-ui'` 落在 `openNoteEvent.ts` 三分规则第 2 条（显式非 Notes 自有 source → Chat 处理）：legacy 视图由 `useChatPageEvents.handleOpenNote` 走 `openCanvasWithNote` 或回落 `navigateToNote`；workbench 模式下 `WorkbenchEventBridge` 对该 source 依约不接 `DSTU_OPEN_NOTE`，但接回落的 `navigateToNote` 开笔记窗。**未增删 `NOTES_OWNED_OPEN_NOTE_SOURCES`**，openNoteEvent 头注要求的「增删 source 同步两侧测试」不触发（先例：`saveTextAsNote.ts` 的 `source='save-as-note'` 同样零改动接入）。锚点经模块级 pending map 传递，不依赖哪一侧最终开窗。

### 打开 PDF 页

```
GenUI ActionBar 按钮点击
  → dispatchOpenPdfPageNavigation({ sourceId, pageNumber })
  → document.dispatchEvent('pdf-ref:open', { sourceId, pageNumber })
```

与 Chat Markdown 内联引用 `[PDF@id:3]`（`MarkdownRenderer.tsx` `data-pdf-ref` 点击）**同事件、同 detail 形状、同消费方**：`useChatPageEvents.handlePdfRefOpen`（legacy，解析 sourceId → NAVIGATE_TO_VIEW learning-hub + 页 focus）与 `WorkbenchEventBridge.onPdfRefOpen`（workbench，launch textbook/file 窗 + 延迟 `pdf-ref:focus`）。

### intent ↔ handler 对齐（组合 action id）

ActionBar 的 `runAction` 调 `handler.handler()` 不带 payload，目标必须在注册期绑定。多目标场景下 id 按同一组纯函数派生：

- `openNoteActionId(noteId)` → `open-note:<noteId>`
- `openPdfPageActionId(sourceId, page)` → `open-pdf-page:<sourceId>:<page>`
- `parseOpenResourceActionId(actionId)` → 强校验反解（chat bridge 用）

`buildOpenResourceEntryBlock`（intent 侧）与 `createOpenResourceActionHandlers`（handler 侧）共用组合函数，天然满足 actionHandlerSync 契约口径；两侧对非法目标同口径跳过。

## 三、只读边界论证（本轮核心不变量）

1. **零写 API**：新模块 import 面 = `headingTargetBridge`（内存 pending map + window 事件）+ 类型。无 `dstu.*`、无 `invoke(`、无 `saveNoteContent` / `createNote` / `saveAnkiCards` / `canvas:ai-edit-request`。测试文本含源码级反向闩（`invoke\(` 与写路径符号 0 命中断言）。
2. **风险级恒 low、无 undo**：导航不产生可撤销的持久化变更，不进 HITL 撤销栈（`resolveGenerativeActionUndo` 得 undefined，不 push）。
3. **信任面与既有引用持平**：chat bridge 从模型输出的 action id 反解目标，模型能做的只是**点名一个既有资源 id**——与它今天已能在 Markdown 里写 `[PDF@id:3]` 让用户点击导航完全同级；打开不存在的 id 由既有消费链兜底（chat 侧 resolve 失败 toast / hub 恢复校验）。反解强校验：id 白名单形状 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（≤48 字符，拒路径分隔/空白）、页码 `1..99999` 整数且拒前导零、组合 id ≤64（对齐 `actionBarPropsSchema.id max(64)`）。形状不符 → 不注册 → 注册表安全模式下按钮**不渲染**（Round 66 既有行为，零新代码）。
4. **模型 label 不可信面不变**：`trustedLabel` 优先 handler 注册 label（chat bridge 给定值），模型自报文案只在无 handler 时可见——而无 handler 时按钮根本不渲染。
5. **锚点注入面**：heading 只在**宿主确定性创建** handler 时可绑定（closure）；chat 反解路径不含 heading（不从模型输出取任意文本喂 pending map）。

## 四、接入面（本轮已通电 / 留给宿主）

- **已通电（chat）**：`resolveGenerativeUIChatActionHandlers` 自动注册两类前缀 action。模型（或确定性 builder）在 action-bar 里声明 `{"id":"open-pdf-page:tb_x:3","label":"…"}` 即得可点的只读导航钮。few-shot / prompts **本轮未加示例**——是否教模型主动产出该 id 属产品裁决，先保「声明即可用」。
- **留给宿主（不在本轮可写区）**：`NotesContextPanel` 只读摘要、PDF 摘要卡等宿主可 `buildOpenResourceEntryBlock({...})` append 到 intent.blocks 并把 `createOpenResourceActionHandlers({...})` 并入 actionHandlers。示例（文档性质，未落码）：

```ts
const entry = buildOpenResourceEntryBlock({
  notes: [{ noteId, label: t('…openNote'), heading: sectionHeading }],
  pdfPages: [{ sourceId, pageNumber: page, label: t('…openPdfPage', { page }) }],
});
if (entry) intent.blocks.push(entry);
Object.assign(handlers, createOpenResourceActionHandlers({ notes: […], pdfPages: […] }));
```

## 五、i18n 移交（本轮无权写 locales）

chat bridge 用既有 `fallbackLabel` 范式（defaultValue 兜底，en 环境会露中文直至补键），需 i18n 员在 `generativeUi.json` `action` 组补两键（zh/en）：

| key | zh-CN 建议 | en-US 建议 |
|---|---|---|
| `action.open_note` | `打开笔记` | `Open note` |
| `action.open_pdf_page` | `打开 PDF 第 {{page}} 页` | `Open PDF page {{page}}` |

## 六、已验证 / 未验证

**已验证（静态）**：

- 两条消费链行号级核对（`useChatPageEvents` DSTU_OPEN_NOTE / pdf-ref:open 两 handler、`WorkbenchEventBridge` onDstuOpenNote/onPdfRefOpen/onNavigateToNote、`openNoteEvent.ts` 三分规则、`headingTargetBridge` pending 语义）。
- 组合/反解函数边界值手推（空 id、路径注入、超长、页码 0/小数/前导零/越界、`open-pdf-page::3`）。
- `generativeUIArchitectureContract.test.ts` 各断言逐条比对：全部为存在性/包含性断言，本轮纯增量不触碰；`index.ts` 无 `createFlashcardSaveActionHandlers` 字样（反向闩仍绿）。
- 循环依赖：`headingTargetBridge` → `wikilinks`（UI 无关纯 helper），不回指 generative-ui。
- 禁改区 grep（`FlashcardPreview|anki|tool_loop|coordinator|buildHpiasResearchDashboard`）：本轮 diff 零命中。

**未验证（如实声明）**：

- 未跑 vitest / tsc：新测试文件红绿未知；类型正确性为人工比对（第 8 轮前禁止执行）。
- 「chat 窗回落 navigateToNote → workbench 开窗」为读码推演，未真机点按；heading 在 Learning Hub NoteContentView 宿主下是否消费 pending map 未逐行核验（wikilink 同机制先例在，风险低）。
- ActionBar 内新按钮的实际渲染/键盘循环未跑（复用既有 ActionBarBlock，零改动）。

## 七、遗留移交

1. i18n 两键（见 §五）。
2. 宿主接入（NotesContextPanel / PDF 摘要卡 append 入口块）归各宿主域轮次。
3. 若产品裁决教模型主动产出 open-resource id，补 `prompts/fewShotExamples.ts` 示例 + schemaToPromptHint 提示（本轮刻意未做）。
4. 第 4 轮遗留的孤儿库函数裁决（`sendSelectionToQuestionGeneration` 等）不属本卡（那是 Agent 结合-1 / 划词域的账），本轮未触碰。
