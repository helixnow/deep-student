# Wave2-B 第 1 轮 · PDF 阅读调研:MarginNote / Zotero / PDF Expert 对标差距清单

- 角色:调研员-PDF阅读(第 1 轮,只产出文档,不改产品代码)
- 基线:`cursor/0824-wave2-desktop-subapps-a875`,复核锚点 `82e016b7`(含 `061b4815` 全部内容)
- 对照对象:`EnhancedPdfViewer.tsx` + `PdfSelectionActions.tsx` + `selectionStudyActions.ts` + `pdfSelectionActions.ts` + `src/shared/selection/**` + `TextbookContentView` / `FileContentView` 划词接线
- 参考评审:`docs/0824-quality-review/pdf-documents.md`、`docs/0824-quality-review/learning-notes.md`(划词保存段,§P1「同一选区两个保存入口」)
- 外部调研来源:MarginNote 4 官网与用户手册(marginnote.com、manual.marginnote.cn/en/study)、Zotero 官方文档(zotero.org/support/pdf_reader、kb/annotations_in_database)与官方论坛、PDF Expert 官方帮助(pdfexpert.com、apphelp.readdle.com)

---

## 一、特别标注四项的复核结论(先复核,不重做)

按任务要求先核实四个已知问题在当前分支的真实状态,避免第 2–5 轮重复劳动:

### 1.1 documentTitle=fileName —— ✅ 已修,勿重做

Step 22 提交 `a25d56e4`(fix(pdf): pass fileName as selection-toolbar documentTitle, not DSTU id)**已是当前 HEAD 的祖先**(`git merge-base --is-ancestor` 验证通过)。现码:

```3275:3284:src/features/pdf/components/EnhancedPdfViewer.tsx
      {/* 阅读划词工具条（共享层 SelectionToolbar）：解释 / 翻译 / 保存为笔记 /
          生成卡片 / 添加到聊天。挂在选区下方，与上方的高亮选色菜单错开。
          注意：documentTitle 必须用 fileName——DSTU resourcePath 的末段是资源 ID
          （如 /我的教材/tb_xyz789），不是人类可读的文件名。 */}
      <PdfSelectionActions
        containerRef={containerRef}
        enabled={resolvedEnableTextSelection}
        isMobileLike={isMobileLike}
        documentTitle={fileName}
      />
```

第 3283 行传的是 `fileName`,且注释钉住了「为什么不能用 resourcePath 末段」。后续轮次**不需要**再动这一行;但注意 `learning-notes.md:61` 指出的衍生问题(共享保存的标题推导、页码缺失)只解决了「ID 当标题」一半,**页码 locator 仍未随共享链路传递**(见 §3.2 差距 G3)。

### 1.2 CSS 分隔线双定义 —— ✅ 已修,勿重做

`pdf-documents.md:115` 报的 `.ds-highlight-menu__divider` 双定义已被合并:唯一规则定义在 `src/features/pdf/styles/enhanced-pdf.css:742-749`(合并了原两处的 `align-self/margin` 与 `height/flex-shrink`,并有注释解释合并策略);原第二处(`:1962-1963`)只剩一条「此处不再重复」的注释,无规则体。grep 命中两处是因为注释文本含类名,不是真双定义。

### 1.3 双链路同屏(ds-highlight-menu vs SelectionToolbar)—— ❌ 未修,仍是第 4 轮主任务

两条链路在现码中**都活着且同屏**:

- **链路 A(自研高亮菜单)**:桌面浮动菜单 `EnhancedPdfViewer.tsx:3290-3335`(className `ds-highlight-menu`),移动端底部条 `:3337-3410`(`ds-pdf__highlight-bar`)。动作:4 色高亮(`:3304-3307`)+ 复制(`:3311`)+ 引用到对话(`:3314-3318`,条件 `onQuoteToChat`)+ 做笔记(`:3319-3323`,条件 `onCreateNote`)+ 翻译(`:3324-3326`)+ 生成题目(`:3328-3330`)+ 制卡(`:3331-3333`)。由 document 级 `mouseup/touchend/selectionchange` 驱动(`:1651-1684`),经 `handleTextSelection`(`:1309-1368`)设置 `pendingHighlight`。
- **链路 B(共享层)**:`PdfSelectionActions.tsx:124-141` 把 `@/shared/selection` 的 `SelectionToolbar` 挂到同一个 `containerRef` 上,`placement="below"`。动作:复制 + 解释 + 翻译 + 保存为笔记 + 制卡 + 添加到聊天。由 `useTextSelection`(`src/shared/selection/useTextSelection.ts`)独立再监听一遍 mouseup/selectionchange。

同一次选区两条工具条同时弹出(A 在上、B 在下),重叠动作的行为分叉全部仍在:

| 动作 | 链路 A | 链路 B | 分叉 |
|---|---|---|---|
| 翻译 | `ds-pdf__translation-panel` + `React.lazy` 的 TranslationPopover(`EnhancedPdfViewer.tsx:89-91,3498-3514`;CSS `:1965-1985`) | `ds-pdf__selection-panel` + 静态导入的同一组件(`PdfSelectionActions.tsx:29,171-180`;CSS `:1993-2031`) | 同一个组件、两个面板类、两套定位规则 |
| 制卡 | `selectionStudyActions.makeCardsFromSelection` 动态 import(`selectionStudyActions.ts:117-126`) | 静态导入同一服务(`PdfSelectionActions.tsx:30,105-112`) | 入口重复;A 侧本地拦截过短选区(`EnhancedPdfViewer.tsx:1407-1418`),B 侧靠服务内部校验 |
| 笔记 | `onCreateNote` 回调 → 上层直接 `dstu.create('/')` 落根目录、带页码来源行(`FileContentView.tsx:278-297`;`TextbookContentView.tsx:527-547`) | `useSaveAsNoteFlow` 弹目录选择器,正文只有 `> {documentTitle}` 引用行、**无页码**(`PdfSelectionActions.tsx:99-103`) | 同名按钮,落点语义与元数据完全不同 |
| 送聊天 | 见 §1.4 | 见 §1.4 | 三条通道 |

`learning-notes.md:54-63` 的判词仍然成立:「重叠被当作布局问题解决了,而不是当作重复问题解决」。52-wave2 提示词第 4 轮已排「划词收敛-实现1/实现2」,本文档 §四 给出收敛设计输入。

### 1.4 聊天通道三条 —— ❌ 未修

- 通道 1:链路 A「引用到对话」→ `onQuoteToChat` 回调 → 上层 `useReferenceToChat().referenceToChat`,携带 `sourceType/sourceId/selectedText` + `page:N` locator(`TextbookContentView.tsx:513-524`;`FileContentView.tsx:264-275`;locator 构造在 `pdfSelectionActions.ts:20-22`)。
- 通道 2:链路 A「生成题目」→ `dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, ...)`(`selectionStudyActions.ts:100`)。
- 通道 3:链路 B「添加到聊天」→ 裸 `window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', ...))`(`PdfSelectionActions.tsx:114-118`)。

三条都真实生效但语义能力不同:只有通道 1 携带资源引用与页码 locator(可回链);通道 2/3 是纯文本预填,来源信息分别靠 prompt 文案(`selectionStudyActions.ts:47-58`)和完全没有。收敛方向见 §四 S3。

### 1.5 懒加载被静态导入抵消 —— ❌ 未修

三处证据链完整保留:

- `EnhancedPdfViewer.tsx:89-91`:`React.lazy(() => import('@/features/chat/components/TranslationPopover'))`,注释「懒加载避免把翻译链路打进 PDF chunk」;
- 但 `EnhancedPdfViewer.tsx:83` 静态导入 `PdfSelectionActions`,后者在 `PdfSelectionActions.tsx:28-30` 静态导入 `ExplainPopover`、`TranslationPopover`、`generateCardsFromSelection`;
- `selectionCardGeneration.ts:16` 顶层静态导入 cardforge 的 `cardAgent`,于是 `selectionStudyActions.ts:117-126` 的动态 import 包装(头注:「为避免把 cardforge 打进 PDF chunk,调用方应通过本模块的懒加载包装进入」)也被抵消。

结果:翻译链路 + cardforge 全部随 PDF chunk 打包,两处懒加载沦为纯开销。此项与 §1.3 是同一刀:双链路收敛为一条后,保留哪侧的加载策略要在第 4 轮一并裁决(建议:保留动态 import,收敛后的唯一工具条经 `selectionStudyActions` 的懒加载包装进入重能力)。

---

## 二、现码能力盘点(锚定基线)

对标前先说清楚我们已有什么:

| 能力 | 现状 | 锚点 |
|---|---|---|
| 高亮 | 4 固定色,矩形集合按页面宽高归一化(coordVersion=2) | `EnhancedPdfViewer.tsx:150-158,1341-1358`;色值 `:290` 附近 `HIGHLIGHT_COLORS` |
| 高亮持久化 | DSTU metadata + annotationRevision OCC,冲突/失败/远端覆盖均有用户可见通知;跨窗口经 Tauri 事件收敛 | `:1786-1905`;`pdfAnnotationEvents.ts:23-67` |
| 高亮改色/删除 | 点击高亮块弹操作层(桌面浮动 `:3413-3452`/触屏底条 `:3455-3494`) | 同左 |
| 批注侧栏 | 侧栏 4-tab(目录/缩略图/书签/批注),批注列表点击**只跳页**,可删除 | `:3165-3203`(`renderHighlightList`),`:141`(SidebarMode) |
| 书签 | 独立于高亮的页级书签(id/page/title) | `:160-166` |
| 摘录成笔记 | 链路 A:引用块+来源行(`《name》第 N 页`)落根目录;链路 B:选目录但无页码 | `pdfSelectionActions.ts:24-42`;`FileContentView.tsx:278-297`;`PdfSelectionActions.tsx:99-103` |
| 划词翻译/解释 | 翻译两套面板(§1.3);解释仅链路 B 有 | 同 §1.3 |
| 划词出题 | 组装 prompt 送聊天 Agent 的 qbank-tools(带文件名+页码来源行) | `selectionStudyActions.ts:43-102`;`EnhancedPdfViewer.tsx:1389-1403` |
| 划词制卡 | `cardAgent.startGeneration` → 后端 `start_enhanced_document_processing`(与 chatanki 同一后端入口),后台任务 + 任务台 | `selectionCardGeneration.ts:93-141` |
| 每文档视图状态 | localStorage 持久化 zoom/scale/viewMode/coverOffset | `pdfViewState.ts`;`EnhancedPdfViewer.tsx:426-434,687-728` |
| Agent 跳页 | ACR `gotoPage` 能力(textbook/file/file-preview),`pdf-ref:focus` 事件 + ack + 1.5s 超时 + stale 防双跳,跳页成功有目标页渐隐演出 | `agentManifests.ts:382,412-418,453`;`register.ts:524-527,548-556`;`pdfFocusAck.ts:14-`;`usePdfFocusListener.ts`;`EnhancedPdfViewer.tsx:730-`,CSS `:962` |
| Agent 批注感知 | 后端 DSTU 写批注发 `pdf-annotations:changed`,已开阅读器自动收敛 | `pdfAnnotationEvents.ts:3,59-67`;`EnhancedPdfViewer.tsx:1739-1776` |

**与 Zotero 同构的架构优势值得点名**:Zotero 官方明确论证「批注存数据库而非 PDF 文件内」换来了免冲突同步、可打标签、可被插件/API 读取。我们的高亮同样存 DSTU metadata 而非 PDF 文件,且已有 OCC 与变更事件——这意味着下文大多数差距(批注检索、汇总导出、回链)都是**纯前端/纯静态可落地**的,数据层不用动。

---

## 三、SOTA 调研与差距清单

### 3.1 三个标杆的核心机制

**MarginNote 4(摘录组织的标杆)**
- 「摘录即卡片」:PDF 摘录、脑图节点、闪卡是**同一对象的三种形态**;每条高亮自动成卡,卡与原文页双向链接(官网:「Bidirectional links between card and source page」)。
- 摘录自动归组:Auto Add to MindMap 支持三种插入位置——按文档目录(TOC)分组、按文档分组、指定节点下;未入图摘录有独立的「Excerpt Browser」可检索补挂。
- 卡片间 wiki 式双链 + 全局搜索:「every note knows where it came from」;引用另一处内容会生成 backlink,从引用跳回原文。
- 摘录卡直接进 FSRS 复习;Recall 模式对摘录做高斯模糊自测。
- AI 一键摘录(识别标题/图/表/公式十类元素)、AI 生成结构化脑图——均为「建议可拒绝」姿态。

**Zotero 7(批注→笔记回链的标杆)**
- 批注类型:高亮、下划线、便签(sticky note)、区域截图;每条批注可挂**评论 + 标签 + 颜色**,批注面板支持按标签/颜色筛选。
- 「Add Note from Annotations」:一键把整个 PDF 的全部批注抽取成一条笔记,每条摘录自动带**两个链接**——点批注文本选「Show on Page」跳回 PDF 对应页并定位批注;点引文选「Show Item」跳文献条目。
- Markdown 导出时回链变成 `zotero://open-pdf` 深链(含 annotation 参数),外部工具(Obsidian)也能一键回到原文位置。
- 批注存数据库不存 PDF;需要时可导出「嵌入批注的 PDF」,不锁数据。

**PDF Expert(批注面板与汇总导出的标杆)**
- 批注侧栏按页码排序,点击跳转;支持**搜索批注内容 + 按颜色筛选**。
- 「Annotation Summary」:把全部高亮/便签/图形汇总成单一文件,导出 HTML / 纯文本 / **Markdown**,官方明确以「导入 Obsidian 等工具」为场景;iOS 还支持「Annotated Pages」(只含有批注的页拼成新 PDF)。
- 自定义调色板:用户自建颜色集合,用颜色编码语义(黄=要点、蓝=疑问、粉=引文)。
- 高亮之外有下划线、删除线、便签、音频批注。

### 3.2 差距清单(G = Gap,按「用户可感知价值 ÷ 落地成本」排序)

| # | 差距 | 标杆 | 现码事实 | 静态可落地? |
|---|---|---|---|---|
| G1 | **批注列表点击只跳页,不定位到高亮本身** | Zotero「Show on Page」精确滚到批注;PDF Expert 点批注跳对应位置 | `renderHighlightList` 的 onClick 只 `goToPage(hl.pageIndex)`(`EnhancedPdfViewer.tsx:3181-3184`),高亮 rects 数据就在手上(归一化坐标,`:150-158`)却没用来滚动/闪烁定位 | ✅ 纯前端 |
| G2 | **无批注汇总导出** | PDF Expert Annotation Summary(MD/HTML/txt);Zotero Add Note from Annotations | 高亮数组在 DSTU metadata 里,前端全量可得(`:1709-1737`),但没有任何「导出为笔记/Markdown」入口 | ✅ 纯前端(复用 `dstu.create` 建笔记,与摘录笔记同路) |
| G3 | **摘录笔记的来源行是死文本,无回链** | Zotero 笔记内每条摘录可「Show on Page」;MarginNote 卡↔原文双向链接 | `buildSelectionNoteContent` 生成 `> 引用\n\n来源:《x.pdf》第 N 页`(`pdfSelectionActions.ts:37-42`),纯文本;而回跳能力其实已存在——`pdf-ref:focus` + `requestPdfPageFocus`(`pdfFocusAck.ts:14`)就是现成的「打开该资源第 N 页」原语,只差把来源行写成可点击的资源引用格式 | ✅ 前端(格式约定 + 笔记渲染侧识别;跳转复用既有 focus 通道) |
| G4 | **批注不可加评论/标签,无筛选检索** | Zotero 批注 = 高亮+评论+标签+颜色,面板可按标签/颜色筛;PDF Expert 面板可搜索+按色筛 | `Highlight` 只有 id/pageIndex/text/color/rects/createdAt(`EnhancedPdfViewer.tsx:150-158`),无 note/tags 字段;侧栏列表无搜索无筛选(`:3165-3203`) | ⚠️ 字段扩展(metadata JSON 向后兼容,老数据无 note 字段可选读);筛选 UI 纯前端 |
| G5 | **划词制卡不携带来源溯源** | MarginNote 卡片天然知道来自哪页;Anki 生态惯例是卡片带 source | `makeCardsFromSelection` 接口定义了 `sourceName/page`(`selectionStudyActions.ts:104-109` 继承 `SelectionSourceInfo`)但**没有传给服务**;`GenerateCardsFromSelectionInput`(`selectionCardGeneration.ts:35-42`)也没有来源字段,只有 selectedText+context | ⚠️ 前端可把来源行并入 content 文本(零接口改动);正式的溯源字段属 E 的制卡管线契约,B 不得自造(见 §五) |
| G6 | **颜色无语义层** | PDF Expert 自定义调色板做语义编码;MarginNote 摘录工具可自动化设置标签与颜色 | 4 色硬编码常量(`HIGHLIGHT_COLORS`,`:290` 附近),无用户可配名称/含义;筛选也无从谈起(依赖 G4) | ✅ 静态(颜色图例 + 按色筛选是 G4 的子集;自定义调色板可后置) |
| G7 | **高亮/书签/摘录笔记三者互不知晓** | MarginNote 摘录=卡片=脑图节点一体 | 高亮存 metadata.highlights,书签存独立状态(`:160-166,553`),摘录笔记是无关联的新 DSTU note——从笔记找不回高亮,从高亮找不到笔记 | ⚠️ 部分:笔记→原文回链(G3)是第一步;完整对象统一是长线架构,本轮不动 |
| G8 | **无「未整理摘录」聚合视图** | MarginNote Excerpt Browser(View Excerpts Not in MindMap) | 批注 tab 是唯一聚合面,且只有本文档维度;跨文档的摘录/高亮无任何入口 | ❌ 跨文档聚合涉及 DSTU 扫描,超出本轮;单文档内由 G2 汇总导出部分替代 |
| G9 | **无下划线/删除线/便签批注类型** | Zotero、PDF Expert 标配 | 只有矩形高亮一种类型 | ⚠️ 渲染层可静态做(同 rects 不同画法),但字段/迁移与移动端命中区都要动,建议列为候补不进 2–5 轮必做 |
| G10 | **摘录不进复习流** | MarginNote 摘录卡直接 FSRS | 制卡是单向抛任务(fire-and-forget),生成的卡与 PDF 资源无绑定关系 | ❌ 属 E 领域(FSRS/anki 服务层),B 只能在入口处把上下文交足(G5) |

---

## 四、第 2–5 轮可静态落地子集(建议,均不跑编译/测试)

按 52-wave2 的轮次分工(第 4 轮划词收敛、第 5 轮 Agent 结合 + SOTA-PDF),给出**不依赖运行验证、diff 可静态审阅**的子集:

- **S1(G1,小)批注列表精确定位**:点击批注项后除 `goToPage` 外,复用既有「agent 跳页渐隐演出」的 flash 机制(`EnhancedPdfViewer.tsx:730` 起的 `flashAgentFocusPage`)高亮目标区域;高亮块本身已有 `ds-pdf__highlight-rect` DOM,可按 hl.id 定位滚动。改动集中在 `renderHighlightList` 与一个 scroll-into-view 辅助函数,可单测(纯函数:由 rects 求页内滚动偏移)。
- **S2(G2,中)批注汇总导出为笔记**:侧栏批注 tab 加「导出全部批注」按钮 → 按页分组把 highlights 渲染成 Markdown(每条:引用块 + 颜色标记 + 页码来源行,格式复用 `buildSelectionNoteContent`)→ 走链路 B 已有的 `useSaveAsNoteFlow` 选目录落库。纯函数(highlights[] → markdown)可测。对齐 PDF Expert Annotation Summary 与 Zotero Add Note from Annotations。
- **S3(§1.3/1.4,大,第 4 轮主刀)双链路收敛**:保留一条工具条。评审与提示词都倾向:以链路 A 的**能力集**为基(高亮色板、页码 locator、来源标注)吸收链路 B 的「解释」与目录选择式笔记,或给共享 SelectionToolbar 加动作槽后删链路 A 的动作区。无论哪个方向,验收不变量:(a) 一次选区只出一条工具条;(b)「做笔记」唯一且=选目录+带页码来源;(c) 送聊天归一到带 locator 的 `referenceToChat`(纯文本预填场景保留 PREFILL_CHAT_INPUT,裸 `CHAT_V2_SET_INPUT` 退场);(d) 翻译/解释面板只剩一套 CSS(`ds-pdf__selection-panel` 与 `ds-pdf__translation-panel` 二选一);(e) 重能力(翻译/制卡)恢复真实懒加载(消除 `PdfSelectionActions.tsx:28-30` 静态导入,统一走 `selectionStudyActions` 包装)。
- **S4(G3,中)摘录/批注来源行升级为可回链引用**:约定笔记内来源行格式携带 `resourcePath + page`(与 `page:N` locator 同族,参考 `pdfSelectionActions.ts:17-22` 注释里的 `slide:N/line:N/chapter:N` 约定),笔记渲染侧识别后点击 → 打开对应资源并派发 `pdf-ref:focus`。跳转原语零新增(复用 `requestPdfPageFocus`)。这是对标 Zotero「Show on Page」的最小闭环,也是 G7 的第一块砖。
- **S5(G4/G6,中)批注侧栏筛选**:批注 tab 加按颜色筛选(4 色 chips)+ 文本过滤输入框;纯前端列表过滤,可源码级测试。Highlight 增加可选 `note?: string` 字段(向后兼容:老数据缺字段照常读)与列表内编辑入口,是否本轮做由锚定员-pdf 裁量——字段一旦加就要与 OCC 保存链路(`:1786-1905`)一起审。
- **S6(G5,小)制卡内容附带来源行**:在不动 E 接口的前提下,把 `sourceName/page` 拼进送给 `buildSelectionCardContent` 的正文(如追加「【来源】《x.pdf》第 N 页」),让生成的卡片文本自带溯源。真正的结构化 source 字段等 E 的管线契约(§五)。

明确**不做**:G8 跨文档摘录聚合、G9 新批注类型、G10 摘录进 FSRS(E 域)、自定义调色板持久化。

---

## 五、Agent 结合点

### 5.1 已有能力(不要重建)

- **打开指定页**:ACR `gotoPage` 已对 textbook/file/file-preview 三个 typeId 暴露(`agentManifests.ts:382,412-418`),activation 通道 `gotoPage`/`scrollToHeading(payload.page)` 都落到 `requestPdfPageFocus`(`register.ts:524-527,548-556`;`preview/register.tsx:38`),带 ack/超时/stale 防双跳(`pdfFocusAck.ts`,有完整测试 `pdfFocusAck.test.ts`)。**第 5 轮「Agent 结合-1」不需要新建跳页通道,只需补文档/manifest 描述。**
- **批注双向收敛**:Agent 经 DSTU 写高亮后,后端事件 `pdf-annotations:changed` 让所有已开阅读器自动刷新(`pdfAnnotationEvents.ts:59-67`;`EnhancedPdfViewer.tsx:1739-1776`)。Agent 侧「替用户标重点」的写路径在数据层已通,缺的只是 agent manifest 里的显式能力声明。

### 5.2 缺口(第 5 轮候选)

1. **打开指定锚点(比页更细)**:`gotoPage` 只到页;对标 Zotero 的 annotation 级深链,可在 `pdf-ref:focus` 的 detail 上扩展可选 `highlightId`,viewer 收到后跳页 + 滚动定位 + 闪烁(与 S1 共享实现)。事件负载扩展向后兼容(老监听者忽略新字段)。
2. **Agent 读取批注面**:manifest 的 `observe` 目前只报 resourceId/ready(`agentManifests.ts:447-470`),不含高亮摘要。可补充只读投影(如 highlights 数量、各页分布),让 Agent 能回答「这本书我标了什么」。只读、无风险。
3. **按资源发起制卡——必须走 E 接口,不自造判分/管线**:现成的唯一合法入口是 `cardAgent.startGeneration` → 后端 `start_enhanced_document_processing`(`selectionCardGeneration.ts:118-131`,头注写明与 chatanki_start 共用同一后端入口);出题的唯一合法入口是聊天 Agent 的 qbank-tools(`selectionStudyActions.ts:4-13` 的调研结论:`import_question_bank_stream(format='txt')` 是解析已有题目的抽取流,对散文材料得空结果,**不能**拿来出题)。Wave2 分工明文(52-wave2 §B 边界):「只消费 E 定义的接口,不自造第二套判分语义」;anki/qbank 服务层、mastery、qbank_grading 归 E。因此 B 侧「Agent 按资源发起制卡」的正确形态是:Agent → 读资源选段(DSTU)→ 调 `cardAgent.startGeneration`(带 S6 的来源行)或预填 qbank 出题 prompt——**不新增 tauri command、不碰 CriticSummary/verdict、不在前端算任何分**。若需要结构化 source/溯源字段,提需求给 E,在 E 的管线契约里加,B 只做透传。

---

## 六、风险与边界备忘

- 本轮(r1)零产品代码改动;CSS 与懒加载相关修复由**锚定员-pdf 独占**,本文档只提供事实锚点与验收不变量,行号以 `82e016b7` 为准,后续轮次改码后需重新对表。
- S3 收敛动刀前必须保住的既有修复:选区菜单视口钳位(`pdfSelectionActions.ts:67-100` + `useClampedMenuFrame`)、旋转态只禁创建高亮(`EnhancedPdfViewer.tsx:1343-1358`)、触屏 touchend/selectionchange 补偿(`:1649-1684`)、Android 返回键面板优先关闭(`PdfSelectionActions.tsx:76-83`)、`documentTitle=fileName`(§1.1)。
- 链路 B 的「保存为笔记」底层 `saveTextAsNote` 存在「目录移动失败仍报成功」问题(`learning-notes.md:46-48`),属 `src/shared/notes` 共享层;S3 统一笔记落点时若复用该流,需在 PR 里点名这个上游缺陷,避免把「选了目录 A 实际落根目录」继承进唯一入口。
