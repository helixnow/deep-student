# 0824 Wave2-B 第 4 轮 · 划词收敛(P7)设计与验收细化

- 角色:划词收敛-设计(本轮只写本文档,零产品代码改动;禁止 npm/编译/测试执行;不 commit/push)。
- 终态裁决由父代理给定,本文**不另起炉灶**,只细化事件通道、逐文件删/留清单与验收口径。
- 输入对照:`wave2-B-r1-anchor-pdf.md`(§三 通道地图、§七 插入点表)、`wave2-B-r1-pdf-gap.md`(§1.3/1.4 双链路证据、§四 S3 验收不变量、§六 动刀禁破清单)、`wave2-B-ledger.md` §2.2 编号勘正(本任务=P7)。
- **并行写手警告**:撰写期间「划词收敛-实现」与「阅读器残项」两名实现员正在同一工作树改
  `EnhancedPdfViewer.tsx` / `PdfSelectionActions.tsx` / `selectionStudyActions.ts` /
  `enhanced-pdf.css`(pdfSearch/pdfViewState 亦有第 4 轮无关改动)。本文行号为撰写时
  快照,**验收一律以符号/字符串锚点为准,不以行号为准**;文中「已落地」指撰写时
  工作树已可 grep 到,仍须按 §五 验收清单终态复核一遍。

---

## 一、终态裁决与细化解读

父代理五条裁决(原文要点)→ 本文的可执行口径:

1. **高亮菜单 `ds-highlight-menu` 只保留:4 色高亮 + 复制(+ 必要时分隔线)。**
   - 桌面浮动菜单:色板 4 钮(仅 `canPersistAnnotations && rotation === 0` 时渲染,含其后的
     `ds-highlight-menu__divider`)+ 复制 1 钮。**不再有**引用到对话/做笔记/翻译/生成题目/制卡。
   - 移动底部条 `ds-pdf__highlight-bar`:「高亮」标签 + 同条件色板 4 钮 + 复制 + 关闭钮。
     关闭钮与标签是移动条既有结构件,不算「学习动作」,保留。
   - 高亮块点按后的**操作层**(改色+删除,桌面浮动/触屏底条各一)不是划词菜单,不在本轮收敛范围,零改动。
2. **学习动作单条:`PdfSelectionActions` 挂共享层 `SelectionToolbar`,动作 = 解释、翻译、
   保存为笔记(目录选择 + 页码 locator + 真实 fileName)、制卡、添加到聊天。**
   - 共享组件的「复制」按钮无条件渲染(聊天宿主依赖),因此**复制在两条工具面各出现一次**。
     这是裁决枚举的直接结果(高亮菜单保留复制 + 共享组件自带复制),接受为已知结果,
     **不给 SelectionToolbar 开 hideCopy 洞**——共享层本轮零改动(见 §三.7)。
   - 「生成题目」**不在**裁决枚举的动作清单内 → 终态工具条**没有出题格**。其通道函数的
     处置见第 3 条与 §三.3。
3. **聊天通道归一:带 locator 的回调优先,删除裸 `CHAT_V2_SET_INPUT`,出题走 PREFILL
   并并入同一 locator 封装。**
   - 通道 1(唯一强语义通道):工具条「添加到聊天」→ `onQuoteToChat({ text, page })` →
     视图层 `handleQuoteToChat` → `useReferenceToChat().referenceToChat`(资源引用 +
     `page:N` locator,Agent 可回读原文)。
   - 通道 2(受控兜底):`selectionStudyActions.sendSelectionToChatInput` ——
     `dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, detail)`,detail 在
     `PrefillChatInputDetail` 基础上**并入 `page` / `sourceName`**(这就是「同一 locator
     封装」的落点:消费方后续可升级为资源引用而不必改发起方)。适用面:
     (a) 宿主未注入 `onQuoteToChat`(如独立阅读页 PdfReader);
     (b) 选区页码解析失败(**不许编造页码**——错 locator 比无 locator 更糟);
     (c) 解释/翻译结果面板的「添加到输入框」(内容是 AI 生成文本而非原文选区,
       不适用引用语义,固定走本通道,无 page)。
   - 通道 3(删除):PDF 域内任何 `window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', …))`
     清零。`CHAT_V2_SET_INPUT` 常量与其两个监听方(`useChatPageEvents.ts` legacy 页、
     `WorkbenchEventBridge.tsx` workbench 桥)**不动**——它们还服务 App 壳层 PREFILL 转发
     (`App.tsx` `handlePrefillChatInput`)与聊天域内部(`MessageItem.tsx`),都不属 PDF 辖区。
   - 出题:UI 入口撤除后,`sendSelectionToQuestionGeneration` 的 PREFILL 通道保留在库函数上
     (见 §三.3),未来复用时天然满足「走 PREFILL」;若第 5 轮 Agent 侧重开入口,detail
     须按 `sendSelectionToChatInput` 同款并入 page/sourceName。
4. **懒加载保持第 1 轮修复**(四条闩,见 §五 V5):viewer→`React.lazy(PdfSelectionActions)`;
   组件内两弹层模块级 lazy(named→default 映射);制卡点击时动态
   `import('@/features/chat/services/selectionCardGeneration')`;任何一处退回静态导入都算回归。
5. **`documentTitle={fileName}` 已修不重做**(Step 22 `a25d56e4`),挂载点注释保留
   「必须用 fileName 不是 DSTU 资源 ID」的解释。

---

## 二、终态事件通道表(动作 × 通道 × 监听/消费方)

| 动作 | 所在工具面 | 通道 | 消费链 |
|---|---|---|---|
| 4 色高亮 | ds-highlight-menu(桌面/移动) | 组件内 `addHighlight(color)` | `setHighlights` → DSTU metadata + annotationRevision OCC 落盘(既有链路,零改动) |
| 复制 | 两条工具面各一 | 组件内 clipboard | `copyTextToClipboard`;高亮菜单侧带 toast,共享工具条侧带「已复制」状态钮 |
| 解释 / 翻译 | SelectionToolbar | 组件内 state → 内联结果面板 `ds-pdf__selection-panel` | lazy `ExplainPopover` / `TranslationPopover`(点击才载入 chunk) |
| 保存为笔记 | SelectionToolbar | `useSaveAsNoteFlow({ openSource: 'pdf-selection' })` | 目录选择器 → r3 收口后的 `saveTextAsNote` 单事务(landed 三态);正文 = 引用块 + `pdf:selection.note_source` 来源行(fileName + 页码),标题 = 摘录首 30 字兜底 fileName |
| 制卡 | SelectionToolbar | 点击时动态 import | `generateCardsFromSelection`(内部校验+toast)→ `cardAgent.startGeneration`(E 域唯一合法入口,不自造管线) |
| 添加到聊天(主) | SelectionToolbar | **回调 prop** `onQuoteToChat({text, page})` | viewer 转发 → `TextbookPdfViewer` → `FileContentView.handleQuoteToChat` / `TextbookContentView.handleQuoteToChat` → `referenceToChat`(sourceType/sourceId + `locator: page:N`)→ `pendingContextRefs` |
| 添加到聊天(兜底)/ 弹层结果注入 | SelectionToolbar / 结果面板 | `APP_EVENTS.PREFILL_CHAT_INPUT`(typed `dispatchAppEvent`,detail 携 page/sourceName) | 唯一监听 `App.tsx` `handlePrefillChatInput` → `setCurrentView('chat-v2')` → 150ms 后转发 `CHAT_V2_SET_INPUT`(壳层转发,非 PDF 域派发) |

**被删除的通道/入口**(链路 A 学习动作全套):`openSelectionTranslation`、
`openSelectionQuestionGeneration`、`openSelectionCardGeneration`、`handleQuoteSelection`、
`handleNoteSelection`、viewer 内翻译面板(`ds-pdf__translation-panel` + `SelectionTranslationPopover`
lazy 声明 + `selectionTranslation` state)、`PdfSelectionActions` 旧 `handleAddToChat` 的裸
`CHAT_V2_SET_INPUT` 派发、`onCreateNote` 整条 prop 链。

---

## 三、逐文件删/留清单(给实现员的精确 handler 表)

### 3.1 `EnhancedPdfViewer.tsx`

**删(撰写时已落地,验收复核)**:

| 对象 | 说明 |
|---|---|
| handler:`openSelectionTranslation` / `closeSelectionTranslation` / `openSelectionQuestionGeneration` / `openSelectionCardGeneration` / `handleQuoteSelection` / `handleNoteSelection` | 链路 A 学习动作六个 handler 全删 |
| state:`selectionTranslation` | 连同 Android 返回键 effect 中对它的分支与 deps |
| lazy 声明:`SelectionTranslationPopover` | viewer 内翻译弹层 |
| import:`makeCardsFromSelection` / `sendSelectionToQuestionGeneration` / `MIN_SELECTION_LENGTH_FOR_QUESTIONS`(自 `../selectionStudyActions`) | viewer 不再直连学习动作 |
| `pendingHighlight.context` 字段 + `extractSelectionContext` 调用与定义 | 上下文消歧由工具条自己的 `useTextSelection` 提供,viewer 内零消费者 |
| JSX:桌面菜单与移动条中 引用到对话/做笔记/翻译/生成题目/制卡 五钮 ×2 | 菜单只剩色板(+divider)+复制(移动条另有标签/关闭) |
| JSX:翻译面板块(`ds-pdf__translation-panel`) | 面板只剩共享侧一套 |
| icon import:`ChatCircleText` / `NotePencil` / `Translate` / `Exam` / `Cards` | 删钮后零引用(`Copy`、`Pencil`、`Trash` 等另有使用,保留) |
| prop:`onCreateNote` | **整个删除**(声明+类型+注释),不留 @deprecated 占位——笔记入口已自包含在 PdfSelectionActions,留占位只会诱导回接 |

**留(动刀禁破)**:`handleTextSelection`(仍驱动高亮菜单)、`pendingHighlight{text,pageIndex,rects}`、
`addHighlight`、`closeSelectionMenu`、`handleCopySelection`、`useClampedMenuFrame` 钳位、
旋转态只禁创建高亮(`rotation === 0` 条件)、document 级 mouseup/touchend/selectionchange
补偿监听、高亮块操作层两块(改色/删除)、`React.lazy(() => import('./PdfSelectionActions'))`。

**待办 A(必须,撰写时缺口)**:挂载点(`<PdfSelectionActions` 锚点,现约 3158 行)只传
`containerRef/enabled/isMobileLike/documentTitle` 四 props,而 props 区把 `onQuoteToChat`
标成 @deprecated 且组件体不解构——**通道 1 在唯一挂载点上断线**,「添加到聊天」永远落
PREFILL 文本兜底,违反归一裁决。修复三步:

1. props 区:`onQuoteToChat` 注释从「@deprecated 不再消费」改为
   「划词『添加到聊天』locator 回调,透传给 PdfSelectionActions(上层视图接 useReferenceToChat)」;
2. 组件解构参数里加回 `onQuoteToChat`;
3. 挂载点增加 `onQuoteToChat={onQuoteToChat}`,并把挂载点注释更新为五动作口径
   (解释/翻译/保存为笔记/制卡/添加到聊天)。

### 3.2 `PdfSelectionActions.tsx`(终态规格,撰写时已基本落地)

- props:`containerRef` / `enabled` / `isMobileLike` / `documentTitle?`(必须是 fileName)/
  `onQuoteToChat?: (payload: PdfSelectionPayload) => void`。
- `resolveSelectionPage()`:从 `window.getSelection()` 首个 range 的 startContainer 向上
  `closest('[data-page-number]')` 解析 1-based 页码,且必须 `container.contains(pageEl)`;
  失败返回 undefined。可靠性依据:SelectionToolbar 对 mousedown `preventDefault`,动作回调
  触发时 DOM 选区仍在。
- `handleSaveAsNote`:有 `documentTitle` 且页码可得 → `buildSelectionNoteContent({ text,
  sourceLabel: t('pdf:selection.note_source', { name, page }) })` + 标题取压缩空白后首 30 字
  兜底 documentTitle;页码不可得 → 降级 `> {documentTitle}\n\n{text}`;都经
  `useSaveAsNoteFlow`(目录选择先行,绝不直写根目录)。
- `handleMakeCards`:点击时动态 import `selectionCardGeneration`,传
  selectedText + contextBefore/After + 组件 `t`;短选区校验依赖服务内部(与聊天划词同一套
  toast),不在组件重复。
- `handleAddToChat`:`onQuoteToChat && page 可得` → 回调;否则
  `sendSelectionToChatInput({ text, sourceName: documentTitle, page })`。
- `handleAddDerivedTextToChat`(弹层 `onAddToInput`):固定
  `sendSelectionToChatInput({ text, sourceName: documentTitle })`。
- 禁止出现:`new CustomEvent('CHAT_V2_SET_INPUT'`、静态导入两弹层/`generateCardsFromSelection`、
  `notesDstuAdapter`、`ChatV2AnkiAdapter`/`saveAnkiCards`、Dialog 结果面板。
- 保留:`hideUnavailableActions`、`placement="below"`、
  `viewportBottomInset={isMobileLike ? MOBILE_BOTTOM_INSET_PX : 0}`、`dismissOnLeaveView={null}`、
  Android 返回键先关结果面板(`registerBackHandler` + `BACK_PRIORITY.overlay`)。

### 3.3 `selectionStudyActions.ts`

- **新增(已落地)**:`sendSelectionToChatInput(input: SelectionSourceInfo): boolean` ——
  空文本返回 false 不派发;detail = `{ content, autoSend: false }` 并入可选 `page`/`sourceName`。
- **保留为库函数(无 UI 调用方)**:`sendSelectionToQuestionGeneration`、
  `buildQuestionGenerationPrompt`、`makeCardsFromSelection`、`MIN_SELECTION_LENGTH_FOR_QUESTIONS`。
  裁决执行说明:出题格不在终态工具条上,但出题通道(PREFILL + qbank-tools prompt)是
  r1 §5.2-3 预排给第 5 轮「Agent 按资源发起出题/制卡」的唯一合法形态,函数与其测试
  (`selectionStudyActions.test.ts`)**本轮不删**;第 5 轮若裁定不复用,再按死码流程处理
  (届时连同 `pdf:selection.questionPrompt*`、`selectionEmpty`、`selectionTooShort` 键一起)。
  台账员请在 r4 节记一笔「孤儿库函数,归属第 5 轮裁决」。

### 3.4 视图层(**待办 B,必须**)——删 `onCreateNote` 整条 prop 链

| 文件 | 删 | 留 |
|---|---|---|
| `FileContentView.tsx` | `handleCreateNote`(约 281-290)、其 `useSaveAsNoteFlow` 实例与 `startSaveAsNote`(约 279-280)、`<SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />`(约 884)、import 中 `SaveAsNoteFolderPicker/useSaveAsNoteFlow`(60)与 `buildSelectionNoteContent`(63)、`onCreateNote={handleCreateNote}`(约 742) | `handleQuoteToChat` + `onQuoteToChat={handleQuoteToChat}`(约 264-275、741)与 `buildSelectionLocator` import——通道 1 的唯一实现,一个字不动 |
| `TextbookContentView.tsx` | 同型:`handleCreateNoteSync`(约 530-539)、flow 实例(528-529)、picker(847)、相关 import(43、46)、`onCreateNote={handleCreateNoteSync}`(845) | `handleQuoteToChat`(约 513-524)与 `onQuoteToChat`(844) |
| `TextbookPdfViewer.tsx` | `onCreateNote` prop 声明(约 51)、解构(74)、透传(274) | `onQuoteToChat` 声明/解构/透传(49、73、273) |

删除前逐文件 grep 确认:该 flow 实例与 `buildSelectionNoteContent` 在文件内没有第二个使用者
(撰写时确认只有划词做笔记一处);删除后 `useSaveAsNoteFlow({ openSource: 'pdf-selection' })`
全仓应只剩 `PdfSelectionActions.tsx` 一处(§五 V8)。

### 3.5 `styles/enhanced-pdf.css`

- `.ds-pdf__translation-panel` 三个规则块删除(已落地,原位留一行指路注释指向
  `ds-pdf__selection-panel`)。
- `.ds-pdf__selection-panel` 系列保留(源码测试断言其存在 + `var(--ds-pdf-safe-bottom)` 避让)。
- `.ds-highlight-menu__divider` 第 1 轮合并后的单一定义保留。

### 3.6 i18n(移交 i18n 员,只记录不擅删)

- **UI 死键候选**(撰写时全仓零非 JSON 引用,zh/en 同步处理):
  `pdf:selection.quote_to_chat`、`pdf:selection.create_note`、`pdf:selection.generateQuestions`、
  `pdf:selection.makeCards`、`pdf:toolbar.translate_selection`。
  复核命令:`rg -n "quote_to_chat|create_note|generateQuestions|makeCards|translate_selection" src --glob '!*.json'`
  (注意 `makeCards` 会命中 chatV2 命名空间的存活键与组件 handler 名,须按完整 key 甄别)。
- **存活键**:`pdf:selection.note_source`(工具条笔记来源行)、`pdf:selection.menu_label`、
  `pdf:selection.copy/copied/copy_failed`、`pdf:selection.questionPrompt*`/`selectionEmpty`/
  `selectionTooShort`(库函数引用,随 §3.3 缓期)、`chatV2:selectionToolbar.*` 全组。
- 本轮**不新增**任何键(出题不进工具条,无新 label 需求)。

### 3.7 明确不动(越权边界)

- `src/shared/selection/SelectionToolbar.tsx`、`useTextSelection.ts`:**零 diff**。不加出题格、
  不加 hideCopy、不动灰显逻辑——聊天宿主共用,任何改动波及 C/聊天域。
- `MessageItem.tsx` 的裸 `CHAT_V2_SET_INPUT`(聊天域内部先例)、`legacyNavigationMap.ts` 的
  `dispatchDeferred`(转发者)、`useChatPageEvents.ts` / `WorkbenchEventBridge.tsx` 两监听方、
  `App.tsx` PREFILL→CHAT_V2 转发:全部不动。
- `events/app.ts` 常量与 detail 类型:`PrefillChatInputDetail` 不改(page/sourceName 以交叉
  类型并入 detail,发起侧局部收窄,不动全局契约)。
- anki/qbank 服务层、`selectionCardGeneration.ts`、`cardAgent`、coordinator.rs、移动 44px/
  coarse 类名、finder 分桶:禁改区照旧。

---

## 四、测试文本跟进(待办 C;只写文本,不执行——第 8 轮前禁令)

1. **`PdfSelectionActions.test.tsx`**(行为测试,撰写时未更新,现有「添加到聊天」用例
   监听 `CHAT_V2_SET_INPUT` 事件,按新契约必红):
   - 头注第 6 条改为「添加到聊天 → 优先 onQuoteToChat locator 回调,兜底 PREFILL 封装」。
   - 用例改三支:(a) 传 `onQuoteToChat` 且容器内造 `[data-page-number]` 包裹的选区 →
     断言回调收到 `{ text, page }` 且未派发 PREFILL;(b) 不传回调 → mock `@/events` 的
     `dispatchAppEvent`,断言 `(APP_EVENTS.PREFILL_CHAT_INPUT, { content, autoSend: false,
     sourceName, page? })`;(c) 传回调但选区解析不到页码 → 走 PREFILL 兜底。
   - 「保存为笔记」用例补断言:`start` 收到的 content 含 `note_source` 来源行、title 为
     30 字截断。
   - 既有「lazy 化后同步断言跑红」问题(`findBy*`/`waitFor` 化)仍归第 7 轮,本轮只改契约文本。
2. **`pdfSelectionToolbar.source.test.ts`**(源码契约,补收敛闩):
   - 正向:actionsSource 含 `sendSelectionToChatInput`、`onQuoteToChat`、
     `resolveSelectionPage`;viewer 挂载块含 `onQuoteToChat={onQuoteToChat}`(待办 A 完成后)。
   - 负向:viewerSource 与 actionsSource 均 `not.toContain("CHAT_V2_SET_INPUT")`;
     viewerSource `not.toContain('openSelectionQuestionGeneration')`、
     `not.toContain('openSelectionCardGeneration')`、`not.toContain('handleNoteSelection')`、
     `not.toContain('onCreateNote')`;pdfCss `not.toContain('.ds-pdf__translation-panel {')`。
   - 既有四条懒加载闩与 `ds-highlight-menu`/`ds-pdf__highlight-bar` 双面并存断言全部保留。
3. **`selectionStudyActions.test.ts`**:补 `sendSelectionToChatInput` 两例——空白文本返回
   false 且零派发;正常输入 detail 形状(含/不含 page、sourceName)。既有出题/制卡用例保留
   (库函数缓期,测试跟着缓期)。
4. **`pdfMobilePanelTabs.source.test.ts`**:断言 `TextbookPdfViewer` import 字符串,与本轮
   删 `onCreateNote` 无冲突,预计零改动;实现员删 prop 后 grep 复核一次即可。

---

## 五、验收清单(grep 干跑口径,全部通过才算 P7 收敛完成)

| # | 断言 | 命令(工作区根目录) | 期望 |
|---|---|---|---|
| V1 | PDF 域裸聊天事件清零 | `rg -n "CHAT_V2_SET_INPUT" src/features/pdf` | 0 命中(测试文本更新后;更新前仅测试文件命中) |
| V2 | 通道 1 全链在线 | `rg -n "onQuoteToChat" src/features/pdf src/features/learning-hub/apps/views` | EnhancedPdfViewer(prop 声明+解构+挂载点转发)、PdfSelectionActions(prop+handler)、TextbookPdfViewer(声明+解构+透传)、两视图(`handleQuoteToChat` + 传参)均命中;无 @deprecated 字样 |
| V3 | onCreateNote 链清零 | `rg -n "onCreateNote" src/features/pdf src/features/learning-hub` | 0 命中(NotesWorkspaceApp/CommandPalette 的同名 prop 属笔记/命令面板域,不在本命令范围) |
| V4 | 高亮菜单动作面 | 人工读 `ds-highlight-menu` 划词块与 `ds-pdf__highlight-bar` 划词块 | 桌面:4 色钮 + divider + 复制,共 5 钮;移动:标签 + 4 色钮 + 复制 + 关闭;无 Translate/Exam/Cards/ChatCircleText/NotePencil 图标 |
| V5 | 懒加载四闩 | `rg -n "React.lazy|import\('" src/features/pdf/components/EnhancedPdfViewer.tsx src/features/pdf/components/PdfSelectionActions.tsx` | viewer lazy PdfSelectionActions;组件内两弹层 lazy + 制卡动态 import;`rg "from '@/features/chat/components/(Explain|Translation)Popover'" src/features/pdf` 与 `rg "import \{ generateCardsFromSelection \}" src/features/pdf` 均 0 |
| V6 | documentTitle 不回归 | `rg -n "documentTitle=\{fileName\}" src/features/pdf/components/EnhancedPdfViewer.tsx` | 1 命中,注释保留 |
| V7 | 翻译面板单套 | `rg -n "ds-pdf__translation-panel" src` | 仅 CSS 指路注释命中;`ds-pdf__selection-panel` 规则体健在 |
| V8 | 笔记入口唯一 | `rg -n "useSaveAsNoteFlow\(\{ openSource: 'pdf-selection' \}" src` | 仅 `PdfSelectionActions.tsx` 1 命中 |
| V9 | 共享层零改动 | `git diff --stat -- src/shared/selection` | 空 |
| V10 | PREFILL 消费面不变 | `rg -n "PREFILL_CHAT_INPUT" src --glob '!*.test.*'` | 监听方仍只有 `App.tsx`;PDF 域发起方只有 `selectionStudyActions.ts` |

行为级不变量(静态不可证,留第 8 轮实测记账):同一次选区上方高亮菜单/下方学习工具条
各司其职互不重叠动作;结果面板打开时工具条让位(`isVisible && !panelOpen`);Escape 与
Android 返回键路径;触屏 132px 底部避让;`referenceToChat` 无活动会话时自建会话。

---

## 六、动刀禁破(r1 §六清单复述 + r3 增补)

选区菜单视口钳位(`resolveSelectionMenuFrame` + `useClampedMenuFrame`)、旋转态只禁创建
高亮、触屏 touchend/selectionchange 补偿、Android 返回键面板优先关闭、
`documentTitle=fileName`、r3 的 `saveTextAsNote` 单事务 + landed 三态(工具条笔记走的
就是这条,PR 描述不必再点名旧「目录移动失败仍报成功」缺陷——r3 已修)。

## 七、遗留与协调

1. **待办 A**(viewer 转发 `onQuoteToChat`,§3.1)与**待办 B**(视图层删 `onCreateNote` 链,
   §3.4)是本轮收敛的收尾必做;**待办 C**(测试文本,§四)随后;i18n 死键(§3.6)移交。
2. `sendSelectionToQuestionGeneration` / `makeCardsFromSelection` 成为无 UI 调用方的库函数,
   归属第 5 轮 Agent 结合裁决(复用或死码化),台账员记账。
3. `EnhancedPdfViewer.tsx` 同时承载「阅读器残项」的 pdfSearch/pdfViewState 改动,合并
   审阅时按符号锚点对表,不以本文行号为准。
4. 第 7 轮测试对齐(lazy waitFor 化)范围不变,叠加本文 §四.1 的契约改写。
