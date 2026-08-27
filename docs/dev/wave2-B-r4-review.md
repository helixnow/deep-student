# 0824 Wave2-B 第 4 轮 · 审阅记录(划词收敛 P7 + 并行任务越权核查)

- 角色:第 4 轮审阅员。禁 npm/vitest(未执行任何编译/测试);未 commit/push。
- 依据:`wave2-B-r4-selection-toolbar-design.md`(下称「设计文档」)+ 工作树现 diff。
- 本轮审阅动刀:仅 `EnhancedPdfViewer.tsx` 三处接线(见 §一);其余全部为只读核对与记账。

---

## 一、必修补丁:viewer 转发 `onQuoteToChat`(设计文档待办 A)——已打

**缺口确认**:补丁前 `EnhancedPdfViewer.tsx` 的 `onQuoteToChat` prop 被标
`@deprecated` 且组件解构参数不含它,`<PdfSelectionActions` 挂载点只传
`containerRef/enabled/isMobileLike/documentTitle` 四 props——通道 1(资源引用 +
`page:N` locator)在唯一挂载点上断线,「添加到聊天」永远落
`sendSelectionToChatInput` 的 PREFILL 文本兜底,违反归一裁决。

**补丁内容**(严格按设计文档 §3.1 待办 A 三步,零额外改动):

1. props 区:`onQuoteToChat` 注释由 @deprecated 改为「划词『添加到聊天』locator
   回调,透传给 PdfSelectionActions(上层视图接 useReferenceToChat)」;
2. 组件解构参数加回 `onQuoteToChat`(`onCreateNote` 维持不解构,注释相应改写);
3. 挂载点增加 `onQuoteToChat={onQuoteToChat}`,挂载点注释更新为五动作口径
   (解释/翻译/保存为笔记/制卡/添加到聊天)并写明「必须转发」的原因。

**prop 名与类型对齐核对**:两侧同名 `onQuoteToChat`,payload 同为
`../pdfSelectionActions` 导出的 `PdfSelectionPayload`(viewer 第 20 行、
PdfSelectionActions 第 35 行同源 import),无需再对齐,PdfSelectionActions 零改动。

**补丁后通道 1 全链**(grep 复核,V2 通过):
`FileContentView.handleQuoteToChat`(741)/ `TextbookContentView.handleQuoteToChat`(844)
→ `TextbookPdfViewer`(声明 49 / 解构 73 / 透传 273)→ `EnhancedPdfViewer`
(声明 168 / 解构 334 / 挂载点转发 3168)→ `PdfSelectionActions.handleAddToChat`
(页码可得走回调,否则 PREFILL 兜底)。`onQuoteToChat` 上不再有 @deprecated 字样。

---

## 二、验收清单核对结果(设计文档 §五,grep 干跑)

| # | 断言 | 结果 |
|---|---|---|
| V1 | PDF 域裸 `CHAT_V2_SET_INPUT` 清零 | **通过(产品代码)**。`src/features/pdf` 命中仅剩:selectionStudyActions/PdfSelectionActions 的解释性注释 ×4、`PdfSelectionActions.test.tsx` 旧用例(头注第 6 条 + addEventListener ×2)。测试文本更新属待办 C(§四),按设计文档缓期,不算本轮红线 |
| V2 | 通道 1 全链在线 | **通过(补丁后)**,链路见 §一 |
| V3 | `onCreateNote` 链清零 | **未通过——记账不拆**(理由见 §三.1)。现存:EnhancedPdfViewer(声明 171,@deprecated,未解构未消费)、TextbookPdfViewer(51/74/274)、FileContentView(742)、TextbookContentView(845) |
| V4 | 高亮菜单动作面 | **通过**。人工读两块 JSX:桌面 `ds-highlight-menu` = 4 色钮(`canPersistAnnotations && rotation === 0` 门禁,含 divider)+ 复制;移动 `ds-pdf__highlight-bar` = 标签 + 同门禁 4 色钮 + 复制 + 关闭。viewer 全文 `Translate/Exam/Cards/ChatCircleText/NotePencil` 零命中(icon import 已删) |
| V5 | 懒加载四闩 | **通过**。viewer 第 82 行 `React.lazy(() => import('./PdfSelectionActions'))`;PdfSelectionActions 内 ExplainPopover/TranslationPopover 模块级 lazy(43-48,named→default 映射)、制卡点击时动态 import(175)。`from '@/features/chat/components/(Explain|Translation)Popover'` 与 `import { generateCardsFromSelection }` 在 pdf 域仅测试负向断言命中,产品代码 0 |
| V6 | `documentTitle={fileName}` | **通过**,1 命中(3167),「必须用 fileName 不是 DSTU 资源 ID」注释保留 |
| V7 | 翻译面板单套 | **通过**。`ds-pdf__translation-panel` 全仓仅剩 CSS 指路注释(enhanced-pdf.css 1958);三个规则块已删;`ds-pdf__selection-panel` 规则体健在 |
| V8 | 笔记入口唯一 | **未达成——随 V3 记账**。`useSaveAsNoteFlow({ openSource: 'pdf-selection' })` 现有 3 个产品实例:PdfSelectionActions(93,终态保留)+ FileContentView(279)+ TextbookContentView(528)(后两个是 onCreateNote 死链的一部分) |
| V9 | 共享层零改动 | **通过**,`git diff --stat -- src/shared/selection` 为空 |
| V10 | PREFILL 消费面不变 | **通过**。监听方仅 `App.tsx`(1817);PDF 域发起方仅 `selectionStudyActions.ts`(60 新增的 sendSelectionToChatInput、125 既有出题函数) |

其余核对:

- **`selectionStudyActions.sendSelectionToChatInput`**:空文本返回 false 不派发;
  detail = `PrefillChatInputDetail & Pick<SelectionSourceInfo,'page'|'sourceName'>`
  交叉类型局部收窄,全局 `PrefillChatInputDetail` 契约未动——与设计文档 §3.3 一致。
  出题/制卡库函数与测试原样保留(孤儿库函数,归属第 5 轮,见 §三.3)。
- **PdfSelectionActions 终态规格**(§3.2)逐条对表通过:resolveSelectionPage
  (closest `[data-page-number]` + `container.contains` + 1-based 校验)、
  handleSaveAsNote(note_source 来源行 + 30 字标题 + 降级)、制卡动态 import、
  handleAddToChat 双通道、handleAddDerivedTextToChat 固定 PREFILL(无 page);
  禁项(裸 CHAT_V2 派发/静态导入弹层/notesDstuAdapter/AnkiAdapter/Dialog)零命中;
  保留项(hideUnavailableActions/placement="below"/viewportBottomInset/
  dismissOnLeaveView={null}/Android 返回键 BACK_PRIORITY.overlay)俱在。

---

## 三、记账(移交后续轮次/台账员)

### 3.1 `onCreateNote` 死链(设计文档待办 B)——本轮不拆,原因与拆除清单

死链性质确认:EnhancedPdfViewer 已不解构不消费该 prop,上游
FileContentView/TextbookContentView 传入的 `handleCreateNote(Sync)` 永远不会被调用,
连带各自的 `useSaveAsNoteFlow` 实例与 `<SaveAsNoteFolderPicker>` 渲染成为死重。

本轮不拆的原因:安全拆除必须同时改
`FileContentView.tsx` / `TextbookContentView.tsx` / `TextbookPdfViewer.tsx` 三个文件
(只删 viewer 侧 prop 声明会破坏上游编译;只删上游调用而留 prop 声明则拆不干净),
三者均不在本轮审阅可写清单内(可写仅 EnhancedPdfViewer 接线 + 本文档)。
EnhancedPdfViewer 的 `onCreateNote` prop 声明(@deprecated 占位)因此一并保留——
先删声明必炸上游。

后续拆除按设计文档 §3.4 表执行(FileContentView 279-290/742/884 + import;
TextbookContentView 528-539/845/847 + import;TextbookPdfViewer 51/74/274;
最后删 EnhancedPdfViewer 声明 168-171),拆完 V3/V8 转绿。
注意保留两视图的 `handleQuoteToChat` 与 `buildSelectionLocator`——通道 1 唯一实现。

### 3.2 测试文本(待办 C,第 7 轮叠加)

- `PdfSelectionActions.test.tsx`:头注第 6 条与「添加到聊天」用例仍按旧契约监听
  `CHAT_V2_SET_INPUT`(11/209/211),按新契约必红;改写口径见设计文档 §四.1。
- `pdfSelectionToolbar.source.test.ts`:尚无 onQuoteToChat/CHAT_V2_SET_INPUT/
  onCreateNote 正负向闩(grep 零命中);待办 A 已完成,可按设计文档 §四.2 补
  「viewer 挂载块含 `onQuoteToChat={onQuoteToChat}`」正向断言。既有懒加载闩与
  双工具面并存断言健在(29/44/45/86-92)。
- `selectionStudyActions.test.ts`:缺 `sendSelectionToChatInput` 两例(§四.3)。

### 3.3 其余记账

- **i18n 死键**(移交 i18n 员,zh/en 同步):`pdf:selection.quote_to_chat`、
  `pdf:selection.create_note`、`pdf:selection.generateQuestions`、
  `pdf:selection.makeCards`、`pdf:toolbar.translate_selection`——复核 grep 确认
  全仓零非 JSON 引用(命中的 `chatV2:selectionToolbar.makeCards*` 与
  `notes:errors.create_note` 属别的命名空间,存活)。
- **孤儿库函数**(归属第 5 轮裁决):`sendSelectionToQuestionGeneration`、
  `buildQuestionGenerationPrompt`、`makeCardsFromSelection`、
  `MIN_SELECTION_LENGTH_FOR_QUESTIONS` 及其测试,现无 UI 调用方。

---

## 四、并行任务越权核查(mindmap / todo / translation 等)

禁改区全 diff 关键字扫描(`anki|qbank|coordinator|finder|44px`,忽略大小写):
仅命中注释与既有 import(androidBackCoordinator),**零禁改区实改**。
`coordinator.rs` / src-tauri 无 diff;`enhanced-pdf.css` 的 44px 触控目标与
`pointer: coarse` 块未动(css diff 仅删翻译面板三规则块);anki/qbank 服务层、
finder 分桶、第 2 轮 dirty checker/save handler 事务(TranslateWorkbench 中
`registerContentDirtyChecker/registerContentSaveHandler` 原样)均未触碰。

| 改动簇 | 归属文档 | 越权判定 |
|---|---|---|
| `pdfViewState.ts` / `pdfSearch.ts` + 两测试 | `wave2-B-r4-reader-residuals.md`(独占可写声明相符,未碰 EnhancedPdfViewer) | 未越权 |
| todo(quickAddParser/types/todoShellNav/TodoMainPanel/utils/ + i18n todo.json)与 `TemplateManagementApp.tsx`(⌘F 快捷键) | `wave2-B-r4-todo.md` | 未越权 |
| `TranslateWorkbench.tsx`(isActive 守卫)+ `src/translation/*`(segmentation/streamBridge/useTranslationStream) | `wave2-B-r4-translate-essay.md` | 未越权 |
| EPUB/教材 | `wave2-B-r4-epub-textbook.md`(零代码改动,纯复核) | 未越权 |
| **mindmap**(ReciteStatusBar 滚动限域 + CSS.escape、clipboardCodec/importers 图片清洗、新增 `utils/imageSanitize.ts` + 测试、types/index 导出 MindMapImage) | **无对应 r4 文档** | 内容本身未触禁改区(纯 mindmap 域,新增运行时图片白名单清洗与实例限域,不碰 PDF/聊天/共享层);但缺任务文档背书,**台账员需补记归属**(疑似并行写手进行中未交文) |

---

## 五、本轮改动清单(审阅员)

- `src/features/pdf/components/EnhancedPdfViewer.tsx`:三处接线(§一),无其它改动。
- `docs/dev/wave2-B-r4-review.md`:本文档。
- 未 commit/push;未运行 npm/vitest/编译(grep 静态核对)。
