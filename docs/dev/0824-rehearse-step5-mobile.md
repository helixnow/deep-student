# 0824 第八轮预演：step 5 mobile（G）

## 范围

- 主体：`origin/cursor/0824-cde6` @ `4f05d227`（E+C+H+A+T+B+D，即含 cloud-sync 与 anki）
- 合入：`origin/cursor/0824-theme-mobile-cde6` @ `4ab24435`（G，与 step3 预演同 tip）
- 预演分支：`cursor/0824-rehearse-step5-mobile-cde6`
- 合并提交：`4f44e87f`；合并后修复：`e7193f93`
- 参考：`origin/cursor/0824-rehearse-step3-mobile-cde6` @ `cb48a5d7`（六轮，G 合到
  含 A 不含 B/D 的 `af3e39d8`）与 F×G 预演
  `origin/cursor/0824-rehearse-step3-fg-cde6` @ `f0efdfea`（其 `078b82db` 已把
  cloud-sync 基线刷进 F×G 树）
- 不合入 F；不修改、不推送 `main` 或 `cursor/0824-cde6`

merge 留下 29 个未合并文件：25 个内容冲突 + 4 个 legacy notes 的
modify/delete。相比 step3-mobile 预演（22+4），新增的 3 个内容冲突全部来自
基线推进段 `af3e39d8..4f05d227`（B/D）与 G 的交叉。

## 解决原则与三类来源

总体不变：以最新 0824（A/D/B）的组件结构、i18n、a11y、测试契约和 bug fix 为
主体，在这些边界上重放 G 的 coarse-pointer 44px 热区、移动布局与 Android
返回键增量；G 已删除的 legacy notes 不复活。执行上按「冲突文件是否被
`af3e39d8..4f05d227` 触碰」分三类：

### 1. 21 个未被 B/D 触碰的冲突：逐字节复用 step3-mobile 裁决

这 21 个文件在 `af3e39d8..4f05d227` 零改动，双方输入与六轮预演完全相同，
直接取 `origin/cursor/0824-rehearse-step3-mobile-cde6` 的已验证 blob：
BatchEditDialog / FilterBuilder / BatchOperationToolbar / CrepeDemoPage /
ErrorBoundary / ExamSheetUploader / QuestionBankListView /
QuestionInlineEditor / SecurityStatusIndicator / SkillsList / UnifiedSidebar /
AnkiTasksApp / FolderPickerDialog / IndexStatusView / McpEditorSection /
McpToolsSection / OcrEngineCard / OcrEngineTestPanel / VendorSidebar /
responsive-utilities.css / secondarySurfaceShellContract.test.ts。
逐文件取舍理由见 `docs/dev/0824-rehearse-step3-mobile.md`，本轮不再重复。

### 2. 3 个 B×G 交叉冲突：复用 F×G 预演的刷新裁决

`CloudStorageSection.tsx`、`RecordConflictsPanel.tsx`、
`DataGovernanceDashboard.tsx` 只被 B 段改过（D 段 `8b70b2d7..4f05d227`
零改动），且 F 不触碰这三个文件，故 F×G 树在这三个路径上的内容 = 本轮同
输入的合并结果，直接取 `origin/cursor/0824-rehearse-step3-fg-cde6` 的 blob：

- `CloudStorageSection`：保留 B 最新的清配置确认、失败重试、E2EE 禁用/
  巡检/导出全链（i18n 调用数与 0824 侧一致），新增操作带 G 的 44px 热区。
- `RecordConflictsPanel`：保留 B 的 cloud-only DELETE 可执行 keep-local 与
  撤销批次列表，窄屏/coarse-pointer 44px 热区保留。
- `DataGovernanceDashboard`：F×G 版本事后发现丢内容，见下节修复。

### 3. `ReviewQuestionsView.tsx`（D×G，手工裁决）

D 的 `9fda519a` 重写了操作栏（开始复习 + 常显「生成卡片」入口、行内二次
确认），且自带 `[@media(pointer:coarse)]:!min-h-[44px]` 热区，语义上覆盖
G 侧唯一增量（旧结构 startReview 按钮的 `!min-h-11`，同为 44px）。裁决：
冲突块整体取 0824/D 侧，弃 G 旧操作栏。G 对该文件其余的自动合并热区
（行 min-h、复选框 44px 扩区、重做按钮、`itemClassName`）核实全部存活
（全文件 10 处 coarse-pointer 站点）。

### Legacy notes 删除

与 step3 预演相同的 4 个 modify/delete 全部跟随 G 删除：
`NotesTabsBar.tsx`、`PreviewPanel.tsx`、`NoteTagsEditor.test.tsx`、
`reference-selector/__tests__/ReferenceSelector.test.tsx`。未复活旧实现。

## 合并后修复（`e7193f93`）

热区套件实测暴露 F×G 树的一处静默回退：其 `DataGovernanceDashboard`
裁决（G 合并期 `2a6ffedb` 所解，F×G 定向测试未覆盖该文件）丢了 A 的页签
可访问名——`TabsList` 的 `aria-label={t('data:governance.tabs_nav_label')}`
与八个 `TabsTrigger` 的逐个 `aria-label`，
`DataGovernanceDashboard.debug-tab-visibility.test.tsx` 5 用例全红。

修复方式：改以 step3-mobile 的已验证裁决为底（A 页签可访问名 + 仅 DEV
显示 Debug 页签门禁 + G 的 coarse-pointer 44px 页签热区），再把 B 段对该
文件的唯一增量 `adc3c8f6`（E2EE zip password 贯穿 backup/exportZip/importZip
回调）以 `git apply --3way` 干净重放。修复后该文件同时通过页签可访问名
5 用例与 B 的 backup-config / backup-operations 32 用例。

## 回退检查

- 与 step3-mobile 预演树全树对比：G 的 689 文件改动面内，差异路径全部落在
  `af3e39d8..4f05d227`（B/D 增量）中，可疑回退为零。
- 与 F×G 树对比：F 未触碰的 B×G 交叉文件（settings/sync/scrollbar 契约）
  逐字节一致；3 个 anki 路径差异均为 D 增量（F×G 树基线早于 D 合入），
  且本树的 anki D×G 自动合并同时保留 D 语义（GenUI 闪卡 display-only，
  无 save-to-library 回流）与 G 热区（ankiCardsBlock 24 处 coarse-pointer）。
- essay-grading / notes 编辑器等 F 也触碰的自动合并交叉文件逐一核对，
  G 触控增量全部存活。

## 门禁

在最终提交 `e7193f93` 上执行（Rust stable 1.98.0 + CI 同款
libwebkit2gtk-4.1-dev 等系统依赖 + `scripts/download-pdfium.sh linux-x64`；
下载脚本对 tracked `pdfium.txt` 的改写已还原，工作树零残留）：

1. `npm ci`：通过，1192 packages。
2. `npm run version:generate && npm run typecheck`：通过，0 错误。
3. `npx vite build`：通过（1m11s），仅既有循环 chunk / 重复导入 / 大 chunk
   警告。
4. `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml --lib`：
   通过，28 warnings、0 errors——与合并前基线持平（G 不触碰 `src-tauri/`，
   Rust 面零变化）。
5. 热区定向测试（16 files / 81 tests 全过）：step3-mobile 的 11 文件套件
   （mobile-uiux 三契约、secondarySurfaceShell、DataGovernanceDashboard
   debug-tab、McpToolsSection 两契约、errorBoundaryCopy、image-viewer
   aria-label、QuestionBankListView a11y、SecurityStatusIndicator a11y）
   + B×G 面（CloudStorageSection.cloudUi、RecordConflictsPanel、
   r07-cloud-only-delete-conflict）+ D×G/自动合并面
   （flashcardDisplayOnly、scrollbarVisualContract）。

## 给正式合并的提示

- 正式在 0824 上合 G 时（若届时 F 已先行合入则以 F×G 预演为主参考；若 F
  仍未合入则本轮即同输入预演），`DataGovernanceDashboard.tsx` 不要照抄
  F×G 树——按本轮 `e7193f93` 的「step3-mobile 底 + `adc3c8f6` 重放」取。
- 其余 24 个冲突 + 4 个删除的裁决可整体沿用本分支树。
