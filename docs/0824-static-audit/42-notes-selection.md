model=claude-fable-5-thinking-xhigh

# 42：划词保存为笔记 / Learning Hub 笔记入口 / #163 吸收情况

- 执行时点：2026-08-26（UTC）。方法：只读静态核对当前树 + 树内既有记录；
  按本轮约束**未使用 git/gh**，未运行测试，未改任何产品文件。
- 基座口径沿用系列 README：`origin/cursor/0824-cde6` @ `2d41ea8b`
  （`docs/0824-static-audit/README.md:3`）。

## 一、划词「保存为笔记」链路盘点

### 1.1 共享层（唯一实现，无平行链路）

- 工具条：`src/shared/selection/SelectionToolbar.tsx` 为聊天与 PDF 共用组件
  （头注释 1-17 行自述；`src/features/chat/components/SelectionToolbar.tsx:1-9`
  仅为 re-export 兼容层）。「保存为笔记」按钮只在宿主真的接了回调时渲染：
  `showSaveAsNote = Boolean(onSaveAsNote)`（`SelectionToolbar.tsx:315`），
  渲染块在 386-397 行——与其它能力的「灰显占位」策略不同，不摆假入口。
- 落点流程：`src/shared/notes/useSaveAsNoteFlow.tsx:58-99` 先弹目录选择器
  （复用 learning-hub 的 `FolderPickerDialog`），确认后调
  `saveTextAsNoteAndNotify`；窄屏走 inline 全屏子屏并由 fixed inset-0 脱离宿主
  裁剪（107-138 行），Android 返回键先关 picker（12-15 行注释声明契约）。
- 写入语义：`src/shared/notes/saveTextAsNote.ts:71-97`——
  `notesDstuAdapter.createNote` 建笔记 → `folderApi.moveItem` 移入所选目录；
  **移动失败不判整体失败**（86-91 行，笔记已存在于根目录，注释解释取舍）。
  标题从正文首行推导、剥 Markdown 标记、50 字符截断（42-55 行）。
  成功 toast 带「打开笔记」动作，走 `DSTU_OPEN_NOTE` 事件（99-127 行）。

### 1.2 已接入共享流程的三个入口

| 入口 | openSource | 证据 |
| --- | --- | --- |
| 聊天消息级「保存为笔记」（消息操作菜单） | `chat-message` | `src/features/chat/components/MessageItem.tsx:767-777`；菜单项 `src/features/chat/components/message/MessageActions.tsx:118-121, 266-270` |
| 聊天划词 | `chat-message` | `MessageItem.tsx:779-782`（同一 flow 实例），工具条接线 1489 行，picker 挂载 1493 行 |
| PDF 阅读划词 | `pdf-selection` | `src/features/pdf/components/PdfSelectionActions.tsx:67, 99-103`（带 `> 文档标题` 引用行）、124-141（`hideUnavailableActions` + `placement="below"` + 底部避让）、185（picker） |

PDF 侧有源码契约测试锁死「不允许绕过目录选择直接写根目录」
（`src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:72-78`，
断言 `PdfSelectionActions` 不 import `notesDstuAdapter`）。共享层自身测试齐备：
`src/shared/notes/__tests__/saveTextAsNote.test.ts`（15 例：标题推导 / 空内容
短路 / 移动失败仍报成功 / 异常转 Result / toast 动作派发 `DSTU_OPEN_NOTE`）、
`__tests__/useSaveAsNoteFlow.test.tsx`（6 例：picker 时序 / 空内容不弹 /
窄屏 inline）。zh-CN 键位齐全（`src/locales/zh-CN/chatV2.json:146-148,
1653-1656`）。

### 1.3 仍在旧路径上的入口（记录，不判修复）

以下入口未走共享目录选择流程，笔记直落资源库根目录、toast 无「打开笔记」动作：

1. **Learning Hub 教材/文件阅读的高亮条「做笔记」**：
   `EnhancedPdfViewer` 高亮选色条上的 `onCreateNote` 按钮
   （`src/features/pdf/components/EnhancedPdfViewer.tsx:1477-1483, 3317-3321,
   3356-3360`）由上层视图落库——
   `src/features/learning-hub/apps/views/TextbookContentView.tsx:526-547` 与
   `FileContentView.tsx:277-297` 均为 `dstu.create('/')` 直写根目录。
   这是有意保留的**摘录笔记**能力（引用块 + 来源页码行），
   `docs/dev/sota-subapp-polish/ROUND-01.md:46-50` 记录其来自 reader 卫星枝，
   用户手册也如此描述（`docs/user-guide/05-文档阅读与翻译.md:59, 138`）。
   结果是同一阅读器内并存两条划词笔记链路：高亮条「做笔记」（落根、即时）
   与其下共享工具条「保存为笔记」（选目录、可打开）——功能语义有别
   （摘录 vs 通用保存），但落点行为不一致，用户面难以区分，记录在案。
2. **快捷助手**：`src/quick-assistant/service.ts:227-233` 的 `saveAsNote`
   仍 `dstu.create('/')` 直落根。`saveTextAsNote.ts:4` 头注释把快捷助手列为
   「改造前一把梭」的入口之一，但改造并未覆盖它——快捷助手是独立
   always-on-top 窗口，无法直接复用主窗口的 `FolderPickerDialog`，属可解释
   的边界，但注释表述与现状有出入。
3. **作文批改「存为笔记」**：`src/components/EssayGradingWorkbench.tsx:1476-1506`
   直接 `notesDstuAdapter.createNote`，无目录选择（整报告保存场景，行为
   与用户手册 `docs/user-guide/09-作文批改.md:77-81` 一致）。

### 1.4 打开笔记的所有权契约

保存成功后的「打开笔记」默认 source 为 `save-as-note`
（`saveTextAsNote.ts:61-63`），按 `src/features/notes/openNoteEvent.ts:13-17,
45-57` 的三分规则属「显式非 Notes source → Chat 侧处理」；Notes 自有
source（notes-editor/wikilink/mention）与无 source 遗留事件归 Workbench。
契约由 `__tests__/openNoteEvent.test.ts` 锁定，chat / workbench 两侧消费者
（`useChatPageEvents` / `WorkbenchEventBridge`）均在位。未发现双开风险。

## 二、Learning Hub 笔记入口

- **新建**：四个入口全部收敛到同一创建路径并支持目录语境——
  侧栏工具栏 `handleNewNote`（`src/features/learning-hub/LearningHubSidebar.tsx:877-898`，
  `createEmpty({ type:'note', folderId: currentCreatableFolderId })`，成功后
  `onOpenApp` 直接打开右侧应用面板）；移动端 P1-20 顶部工具栏同函数
  （3314, 3383-3385 行）；快速访问菜单 `FinderQuickAccess.tsx:236-238`；
  右键菜单「新建笔记 / 在此新建笔记」（`LearningHubContextMenu.tsx:487-491,
  593-597`，后者带目标文件夹 id）；`DstuAppLauncher.tsx:148, 349-351`。
- **打开**：面板内点击走 `onOpenApp` → `UnifiedAppPanel`；跨面（聊天 toast、
  wikilink、mention）统一走 `DSTU_OPEN_NOTE` 三分契约（见 1.4）。
- 与既有 06 号报告（`06-finder-hub.md`，PASS）范围互补，本轮未发现其结论
  需要翻案的事实。

## 三、#163 吸收情况

本轮禁用 git/gh，无法直接核对 PR #163 的 head 与逐提交内容，以下为树内
记录取证：

- **归属**：#163 属 F subapp 卫星群。合并计划明确「F subapp：
  #160/#161/#162/#163/#167 中未被 #176 吸收的能力（按文件移植，不要整 PR
  硬并）」（`docs/0824-MERGE-PLAN.md:42`）。
- **处置口径四轮一致**：
  - `09-invariants-leftover.md:255-259`：按 #308 全量扫描表（基线
    `188500e0`）判「适配吸收 7（#159/#161/#162/#163/#164/#167 + #158
    工具链部分）」；
  - `16-leftover-refetch.md:55-59`：「产品语义已由主题仓或后续端口适配
    吸收；不得按旧 patch 机械重放」；
  - `21-leftover-pass3.md:77-83`：#163 head 提交时间 ≤ 2026-08-25T01:50Z，
    较前两轮无前进，处置不变；
  - `39-leftover-pass4.md:10-23`：第四轮 115/115 开放 PR OID 与第三轮快照
    完全一致，历史处置全部继续有效。
- **证据边界**：与 #160 不同（#160 在 `docs/0824-MERGE-PLAN.md:589-593` 有
  逐提交 PORT/SKIP 处置表），树内**没有** #163 的逐提交清单，其「已吸收」
  结论转引自 #308 全量扫描表（该表本体不在本树）。本轮只能确认：记录体系
  自洽（四轮独立复扫互相印证、head 自扫描以来未动），且 F 群携带的
  笔记/划词面能力在当前树上确实在位（1.1-1.3 节全部实现与测试、
  `ROUND-01.md:46-50` 的 reader 卫星「划词动作菜单（复制/引用/笔记）」
  记录、用户手册两处文档化）。无翻案依据，亦无法在本轮约束下做独立的
  head 内容复核。

## 结论

**PASS（附三条记录项，均不构成本轮修复项）：**

1. 划词「保存为笔记」共享链路（目录选择 → 写入 → 移动 → 带「打开笔记」的
   toast → `DSTU_OPEN_NOTE` 三分所有权）实现、接线、i18n、测试齐备，聊天
   消息级 / 聊天划词 / PDF 划词三入口收敛到同一实现，PDF 侧有防绕过契约
   测试。
2. 记录项：① 教材/文件阅读视图高亮条「做笔记」与同一阅读器内共享工具条
   「保存为笔记」落点行为不一致（前者 `dstu.create('/')` 落根、无打开动作），
   属有意的摘录笔记设计但用户面易混淆；② 快捷助手 `saveAsNote` 未迁共享
   流程，与 `saveTextAsNote.ts:4` 头注释的「统一」表述有出入（独立窗口
   边界可解释）；③ 作文批改「存为笔记」直落根，与用户手册一致。
3. Learning Hub 笔记入口（侧栏/移动端工具栏/右键菜单/快速访问/启动器）全部
   收敛到同一创建路径并带目录语境，打开路径契约无双开风险；不翻案 06 号
   报告的 PASS。
4. #163：树内四轮 leftover 扫描口径一致维持「已由主题仓/端口适配吸收、不得
   机械重放」，head 自扫描以来未动；本轮受禁 gh 约束仅能确认记录自洽与
   现树能力在位，无独立复核、无翻案依据。

**本轮不改代码。**
