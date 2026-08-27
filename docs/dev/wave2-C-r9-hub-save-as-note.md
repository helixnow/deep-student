# Wave2-C 第 9 轮：Learning Hub 小屏划词「保存为笔记」顶栏真空修复

- 席位：第 9 轮 hub/coord 修复席（claude-fable-5-thinking-xhigh）；未 commit / push，未用 computerUse。
- 依据：R6 复核报告 `docs/dev/wave2-C-r6/08-chrome.md` §A（中危翻案，移交本轮裁决）。

## 症状回顾

小屏 learning-hub 右屏 PDF/教材划词 →「保存为笔记」→ `SaveAsNoteFolderPicker` inline 形态
（`fixed inset-0 z-[1200]` 包 `FolderPickerDialog inline`）。该子树仍在 LearningHubPage
移动分支的 `MobileSubviewChromeProvider`（LearningHubPage.tsx:1194）之内，三重失配：

1. `useMobileSubviewChrome` 返回 `host !== null` = true → 自绘「返回 + 标题」行被隐藏；
2. chrome 带 `screen:'center'`，但当前 screenPosition='right' → 宿主屏位匹配失败，统一顶栏不接管；
3. picker 是 fixed 全屏层，统一顶栏本身也被盖住。

净效果：丢标题与返回行（非死路：Android 返回键的本地 `registerBackHandler` 与底部取消/确认条仍在）。

## 裁决修法（已落地）

不改 `hosted` 全局语义（改成「实际接管回执」会伤 F2 中屏「移动到…」的 `screen:'center'`
真接管），改为在 **`SaveAsNoteFolderPicker` 的 inline 分支**外包一层
`<MobileSubviewChromeProvider value={null}>` 切断通道：fixed 全屏承载自成一屏，
`FolderPickerDialog` 经 `useContext` 拿到 null → `hosted=false` → 恢复自绘返回行，
且 `setSubviewChrome` 完全不会被调用（hook 内 `if (!host) return` 早退）。
桌面 Dialog 分支不包。

## 改动清单

仅动 2 个文件（本轮新增 diff，不含工作树里前几轮遗留的未提交改动）：

### `src/shared/notes/useSaveAsNoteFlow.tsx`

- 文件头「移动端契约」文档块补第 3 条（chrome 隔离理由，引 R6 §A，:16-20）。
- 新增 import：`MobileSubviewChromeProvider`（自 `@/components/layout`，:25）。
- `SaveAsNoteFolderPicker` 组件文档块补隔离说明（:112-115）。
- inline 分支（原 :116-128，现 :126-140）：`fixed inset-0` div 外包
  `<MobileSubviewChromeProvider value={null}>`，内部结构与 props 逐字符不变。
- 桌面 Dialog 分支零改动；`useSaveAsNoteFlow` 本体（start/handleConfirm/
  `saveTextAsNoteAndNotify` 调用、openSource 透传）零改动。

### `src/shared/notes/__tests__/useSaveAsNoteFlow.test.tsx`

- `FolderPickerDialog` mock 升级：与真组件同构地调用**真实**
  `useMobileSubviewChrome`（`screen:'center'`、`enabled = inline && open`），
  把 hosted 结果暴露为 `data-hosted`。
- 新增 2 条用例：
  1. `isolates the inline picker from an outer subview-chrome host` —— 外层套
     真 Provider（spy host）复现 R6 §A 承载：断言 `data-hosted='false'`
     （自绘返回行恢复）且宿主 `setSubviewChrome` **零调用**；
  2. `does not isolate the desktop dialog branch` —— 锁「桌面分支不要包」：
     非 inline 时 `data-hosted='true'`，宿主通道仍可见（F2 真接管语义不受影响）。
- 既有 6 条用例（不写盘/确认落库/取消丢弃/inline 切换等）未改语义，全部保持绿。

未另建 `tests/vitest/mobile-uiux/` 契约文件：行为测试直接用真 hook + 真 Provider
锁住了「inline 隔离 / 桌面不隔离」两个方向，比源码字符串断言更强。

## 验证

- `npx vitest run src/shared/notes/__tests__/useSaveAsNoteFlow.test.tsx`：8/8 通过。
- 回归（F2 / PDF 相关既有测试，31/31 通过）：
  - `tests/vitest/learning-hub/learning-hub-sidebar.integration.test.tsx`（1）
  - `tests/vitest/learning-hub/learning-hub-page-events.test.tsx`（1）
  - `src/features/learning-hub/components/finder/__tests__/folderPickerToggleA11y.source.test.ts`（4）
  - `src/features/pdf/components/__tests__/PdfSelectionActions.test.tsx`（11）
  - `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`（14）
- `npm run typecheck:native`（tsgo 全量）：通过。
- `npx eslint` 对两个改动文件：0 error（仅仓库级 boundaries 插件的既有 deprecation warning）。

## F2 未破坏的自证

- F2 主用例（Sidebar 批量移动）直接渲染 `FolderPickerDialog`
  （LearningHubSidebar.tsx:3939，`inline={isSmallScreen}`），**不经过**
  `SaveAsNoteFolderPicker` 壳——隔离 Provider 只存在于壳的 inline 分支内，
  该链路一行未动，中屏 `screen:'center'` 接管照旧。
- `FolderPickerDialog.tsx` 本体零改动（含被禁改的 `screen:'center'`、
  `subviewChromeHosted` 条件自绘、`registerBackHandler`）。
- 新增回归用例 2 明确锁住：非 inline（桌面 Dialog 分支）时宿主通道不被隔离，
  `hosted=true` 语义保留。
- `MobileSubviewChromeContext.tsx` 零改动——`hosted` 全局语义未变，
  F1（NoteContentView）等其他消费者不受影响。

## 禁改区自查

- `FolderPickerDialog` 的 `screen:'center'`：未动（文件零 diff）。
- LearningHubPage finder 逻辑 / Provider 分支：未动。
- `PdfSelectionActions.tsx`：未动（仅渲染 picker，修复在壳内完成）。
- `coordinator.rs` / anki 域 / PDF 域逻辑 / `saveTextAsNote`：未动。
- 未手贴任何 44px 类。

## 遗留

- 真机（小屏 learning-hub 右屏划词）目视验证仍留白，与本 Wave 其他轮次同口径。
- R6 §B 登记的 NoteContentView `propertiesPanelDisabled` 门控差异本轮未触碰（已销案项）。
