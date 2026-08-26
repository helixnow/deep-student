# Wave2-B 第 5 轮 · SOTA-PDF：批注列表组织 + 来源行回链

- 角色：SOTA-PDF（第 5 轮，独占可写：PDF 批注列表 / 回链相关文件）
- 基线：`cursor/0824-wave2-desktop-subapps-a875` @ `2e1c147c`（r4 划词收敛已合入）
- 输入：`wave2-B-r1-pdf-gap.md` §四 S1–S6，本轮选取**摘录组织/回链**子集：
  **S1（批注列表精确定位）+ S2（批注汇总导出为笔记）+ S4（来源行可回链）+ S5（批注筛选）**
- 边界遵守：未动 `documentTitle=fileName`（§1.1 禁重做）；未引入任何第二套划词条
  （`PdfSelectionActions.tsx` / `selectionStudyActions.ts` 全程零改动，避让并行的
  划词菜单辖区）；未触碰 qbank 判分/E 域管线。
- 环境约束：禁 npm、无 node_modules——**未跑编译/测试**，新测试文件为源码级交付，
  由后续轮次/CI 执行。未 commit/push。

---

## 一、做了什么（按 S 项对账）

### S1 批注列表精确定位（G1，对标 Zotero「Show on Page」）

原批注列表点击只 `goToPage(hl.pageIndex)`，高亮 rects 在手却不定位。现：

- `renderPage` 的高亮层加 `data-highlight-id={hl.id}`（`EnhancedPdfViewer.tsx:2903`）；
- 新增 `focusHighlight(hl)`（`EnhancedPdfViewer.tsx:1514-1564`）：`goToPage` 后以
  120ms 间隔轮询（上限 3s）等待目标高亮块渲染——页面虚拟化 + 高亮层随页挂载，
  滚动到位前元素不存在；找到后 `scrollIntoView({ block:'center', behavior:'smooth' })`
  并置 `focusedHighlightId`，1.6s 后移除；
- 闪烁样式 `.ds-pdf__highlight-rect--focus`（`enhanced-pdf.css`）：主题色描边脉冲，
  与 agent-focus 同一套降级——`prefers-reduced-motion` 走静态描边（JS 定时移除），
  `forced-colors` 用系统 Highlight 描边；
- 超时静默放弃：页级跳转已由 `goToPage` 完成，精确定位是增强不是承诺。

### S5 批注筛选（G4/G6 子集）

侧栏批注 tab 从 viewer 内联的 `renderHighlightList` 独立为新组件
`PdfAnnotationsPanel.tsx`（任务要求的「独立模块/侧栏批注 tab」形态）：

- 文本过滤输入框（大小写不敏感包含匹配）+ 颜色 chips（数据源是列表**实际出现**
  的颜色而非硬编码 4 色，兼容 Agent 经 DSTU 写入的非预设色；仅一种颜色时不出 chips）；
- 过滤逻辑全部在纯模块 `pdfAnnotationList.ts`（`filterHighlights` /
  `collectHighlightColors`），列表排序升级为「页码 → 页内 top → createdAt」
  （`sortHighlightsForList`；同页混用坐标版本时退回 createdAt 保证确定性）；
- 空态两档：无批注（沿用既有键）vs 筛选无命中（新键 `annotations.no_filter_match`）。

### S2 批注汇总导出为笔记（G2，对标 PDF Expert Annotation Summary）

- 面板「导出为笔记（N）」按钮：把**当前筛选结果**按页分组渲染为 Markdown
  （`buildAnnotationSummaryMarkdown`：`## 第 N 页` + 引用块 + 来源行），走共享
  `useSaveAsNoteFlow({ openSource: 'pdf-annotations' })` 选目录落库——与划词
  「保存为笔记」同一落库路径，绝不直写根目录；空列表禁用按钮，不导出空笔记；
- 标题 `《{fileName}》批注汇总`（无 fileName 兜底 `批注汇总`）。

### S4 来源行可回链（G3，G7 的第一块砖）

- **格式约定（写入侧）**：来源行写成 markdown 链接
  `[—— 摘自《x.pdf》第 N 页](pdfref://<sourceId>?page=N)`。协议唯一定义在
  `src/components/crepe/plugins/pdfRef/protocol.ts`（`buildPdfRefHref` /
  `parsePdfRefHref`），与 mention 插件的 `note://` 同构；sourceId 取 DSTU
  resourcePath 末段（`resourceIdFromDstuPath`）。resourcePath 不可得（独立阅读页
  打开裸磁盘文件）时降级纯文本来源行，不出假链接；
- **点击侧（笔记渲染）**：新 crepe 插件 `pdfRefPlugin`（`plugins/pdfRef/`，已在
  `plugins/index.ts` 注册，默认启用，可 `pdfRefLink: false` 关闭）：拦截编辑器内
  `pdfref://` 锚点点击 → 派发既有 `pdf-ref:open`（document 事件，detail
  `{ sourceId, pageNumber }`，与聊天 `[PDF@id:N]` 引用徽章同形）。消费方零新增：
  workbench 由 `WorkbenchEventBridge` 拉起 textbook/file 资源窗并按 0/250/800ms
  三连发 `pdf-ref:focus`；legacy 由 ChatV2Page 监听。跳页原语零新建（复核 r1 §5.1）。

### 附带：onCreateNote 死链拆除（r4 记账 V3/V8，提示词授权「若编译安全」）

按 r4 设计文档 §3.4 清单同步拆三个视图层文件 + viewer prop 声明：

| 文件 | 拆除内容 |
|---|---|
| `EnhancedPdfViewer.tsx` | `onCreateNote` prop 声明（@deprecated 占位）+ 解构注释 |
| `TextbookPdfViewer.tsx` | prop 声明 / 解构 / 透传 |
| `FileContentView.tsx` | `handleCreateNote`、`useSaveAsNoteFlow` 实例、`<SaveAsNoteFolderPicker>`、`buildSelectionNoteContent` 与 shared/notes import、`onCreateNote={...}` |
| `TextbookContentView.tsx` | 同型（`handleCreateNoteSync` 等） |

保留项核验：两视图 `handleQuoteToChat` + `buildSelectionLocator`（通道 1 唯一实现）
一字未动。拆后复核 `rg onCreateNote src/features/pdf src/features/learning-hub` = 0 命中
（NotesWorkspaceApp / CommandPalette 同名 prop 属笔记/命令面板域，按设计文档口径不计）；
`useSaveAsNoteFlow({ openSource:'pdf-selection' })` 产品实例只剩 `PdfSelectionActions`
一处——**r4 记账的 V3 / V8 转绿**。

---

## 二、文件清单

新增：

- `src/components/crepe/plugins/pdfRef/protocol.ts` — pdfref:// 协议（纯函数，零依赖）
- `src/components/crepe/plugins/pdfRef/click.ts` — 锚点点击解析（可单测）
- `src/components/crepe/plugins/pdfRef/types.ts` — `pdf-ref:open` 事件契约
- `src/components/crepe/plugins/pdfRef/index.ts` — `$prose` 插件入口
- `src/components/crepe/plugins/pdfRef/__tests__/pdfRefLink.test.ts` — 协议往返 / 点击派发 / 非目标链接放行 / 编辑器外锚点忽略
- `src/features/pdf/pdfAnnotationList.ts` — 排序/分组/筛选/来源行/汇总 Markdown 纯逻辑
- `src/features/pdf/__tests__/pdfAnnotationList.test.ts` — 上述全函数用例（含混合坐标版本、无 sourceId 降级、空列表空串）
- `src/features/pdf/components/PdfAnnotationsPanel.tsx` — 批注 tab 面板（桌面/移动共用）

修改：

- `src/components/crepe/plugins/index.ts` — 注册 pdfRefPlugin（`pdfRefLink` 开关，默认启用）
- `src/features/pdf/components/EnhancedPdfViewer.tsx` — lazy 面板挂载、focusHighlight、data-highlight-id、focus 类名、onCreateNote 声明拆除（改动集中在批注区，不触划词菜单/工具条区块）
- `src/features/pdf/styles/enhanced-pdf.css` — 面板工具行样式 + 定位闪烁动画（含 reduced-motion / forced-colors）
- `src/features/pdf/components/TextbookPdfViewer.tsx`、`src/features/learning-hub/apps/views/FileContentView.tsx`、`.../TextbookContentView.tsx` — 死链拆除
- `src/locales/zh-CN/pdf.json`、`src/locales/en-US/pdf.json` — `pdf:annotations.*` 新增 9 键（两语言同步，无死键：全部被面板引用）

---

## 三、不变量与纪律自查

- **懒加载纪律（r4-V5 延伸）**：`PdfAnnotationsPanel` 经 `React.lazy` 挂载——它静态
  依赖 shared/notes → FolderPickerDialog，不能进 PDF 主 chunk；纯模块
  `pdfAnnotationList.ts` 从 `pdfRef/protocol`（零依赖文件）直接 import，**不经**
  `pdfRef/index`，milkdown 不会被拉进 PDF chunk。
- **一次选区一条工具条**：未动 `ds-highlight-menu` / `ds-pdf__highlight-bar` /
  `PdfSelectionActions` 任何一行；`pdfSelectionToolbar.source.test.ts` 与
  `pdfMobilePanelTabs.source.test.ts` 的全部断言逐条人工比对仍成立
  （lazy 闩、四 tab 44px、`documentTitle={fileName}`、双面并存等）。
- **事件通道零新增**：回链复用 `pdf-ref:open` → `pdf-ref:focus`（ack/超时/stale
  防双跳全部继承）；未新增 tauri command，未碰 E 域。
- **数据层零改动**：`Highlight` 字段未扩展（G4 的 note/tags 字段本轮不加，
  与 OCC 保存链路的联审留给后续轮次）；批注 metadata 读写路径未动。

## 四、风险与已知限制

1. `pdf-ref:open` 在 legacy 模式仅 ChatV2Page 挂载时有监听；workbench（本 wave 主战场）
   由桌面层常驻桥监听。无监听者时点击回链无害无响应。
2. 精确定位对**极端大文档**依赖虚拟列表滚动使目标页进入渲染窗口，3s 轮询上限内
   未渲染则只完成页级跳转（有意的降级，不加长阻塞）。
3. 同页混用新旧坐标版本的高亮排序退回 createdAt（历史数据边缘场景，已测试钉住）。
4. 导出笔记沿用共享 `saveTextAsNote`，其「目录移动失败仍报 landed 语义」上游行为
   由 r3 收口（landed 三态），本轮直接受益，无需另判。

## 五、移交（不在本轮辖区，勿在此文件外自行认领）

1. **划词摘录笔记的来源行升级回链（S4 写入侧另一半）**：`PdfSelectionActions.handleSaveAsNote`
   目前来源行仍是纯文本。划词辖区接手时：给组件加 `resourcePath` prop（viewer 挂载点
   一行透传），来源行改 `buildAnnotationSourceLine({ label, sourceId: resourceIdFromDstuPath(resourcePath), page })`
   即可，格式/点击侧已就绪。
2. **S6 制卡附来源行**：同属 `PdfSelectionActions.handleMakeCards`，把
   `pdf:selection.questionPromptSourcePage` 同款来源行拼进 content 文本；结构化
   source 字段仍等 E 管线契约。
3. **G4 完整形态**（批注评论/标签字段 + OCC 联审）与 **Agent 深链**（`pdf-ref:focus`
   detail 扩展可选 `highlightId`，viewer 侧可直接复用本轮 `focusHighlight`）留后续轮次。
4. **测试执行**：新增两个测试文件 + 既有 pdf 套件在环境恢复后跑
   `vitest src/features/pdf src/components/crepe/plugins/pdfRef`。

（本轮为 Wave2-B 第 5 轮持续工作的一部分，不标记 Goal complete。）
