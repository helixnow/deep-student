# 0824 第六轮预演：step 3 mobile（G）

## 范围

- 主体：`origin/cursor/0824-cde6` @ `af3e39d8`（已包含 theme wrapup A）
- 合入：`origin/cursor/0824-theme-mobile-cde6` @ `4ab24435`（G）
- 预演分支：`cursor/0824-rehearse-step3-mobile-cde6`
- 合并提交：`b69d1316`
- 不合入 F；不修改、不推送 `main` 或 `cursor/0824-cde6`

本轮直接从最新 0824 合入 G，命中 wrapup 的 46 文件重叠面。Git 留下 26 个
未合并文件，其中 22 个为内容冲突、4 个为 legacy notes 的 modify/delete
冲突。

## 解决原则

总体沿用既有 mobile 与 F×G 预演策略，但不引入 F：以最新 0824/A 的组件结构、
i18n、a11y、测试契约和 bug fix 为主体，在这些边界上重放 G 的 coarse-pointer
44px 热区、移动布局及 Android 返回键增量；G 已删除的 legacy notes 不复活。

### A 与 G 的交叉热区

- `BatchEditDialog`、`FilterBuilder`、`BatchOperationToolbar`、
  `ExamSheetUploader`、`QuestionBankListView`、`QuestionInlineEditor`、
  `SecurityStatusIndicator`、`CrepeDemoPage`、`SkillsList`、`AnkiTasksApp`、
  `FolderPickerDialog`、`McpEditorSection`、`McpToolsSection`、
  `OcrEngineCard`、`OcrEngineTestPanel`
  - 保留 A 的本地化 `aria-label`、title 和当前行为。
  - 将 G 的 coarse-pointer 命中区提升到 44px；不恢复硬编码英文 label。
- `ErrorBoundary`
  - 保留 A 的 `resetError` 与“重试”语义，不恢复 G 的“刷新页面”误导文案。
  - 仅把 G 的 44px 触控高度重放到重试按钮。
- `UnifiedSidebar`
  - 保留 A 的 `text-ui` 字号 token，同时保留 G 的触屏平板 `min-h-11`。
- `DataGovernanceDashboard`
  - 保留 A 的页签可访问名称和仅开发环境显示 Debug 页签的门禁。
  - 在 `sm` 以上的 coarse-pointer 设备继续强制 44×44px，避免响应式规则把
    平板触控目标缩回桌面密度。
- `McpToolsSection`
  - 保留 A 为 #46 拆出的“小屏内联、桌面/平板 Popover”结构及视口碰撞钳制。
  - 分别在两个新边界上重放 G 的 44px trigger 热区；环境变量删除、预览和测试
    按钮同时保留 A 的本地化可访问名称。

### 既有 mobile 预演热区

- `IndexStatusView`
  - 保留 A 的 `IndexStatusGenerativeBriefing`、批量索引和刷新接线。
  - 继续采用 G 的独立 `CustomScrollArea` 布局，筛选栏不恢复 obsolete sticky。
- `VendorSidebar`
  - 保留 A 的 dnd-kit `SortableVendorRow` 和统一 `handleSelectVendor`，不恢复
    G 基于旧行内 renderer 的重复拖拽实现。
  - 在新组件边界上补回 G 的触屏平板 44px 行高与 coarse-pointer 拖拽指示常显。
- `responsive-utilities.css`
  - 删除只服务于已下线 legacy notes 树的 `.rct-tree` 移动规则，跟随 G；保留
    A 的 drawer 字号 token 与搜索框 iOS 16px 地板。
- `secondarySurfaceShellContract.test.ts`
  - 保留 A 对移动全屏工具栏条件类的契约说明，断言本身与 G 一致。

### Legacy notes 删除

以下 modify/delete 全部跟随 G 删除：

- `src/features/notes/NotesTabsBar.tsx`
- `src/features/notes/PreviewPanel.tsx`
- `src/features/notes/__tests__/NoteTagsEditor.test.tsx`
- `src/features/notes/reference-selector/__tests__/ReferenceSelector.test.tsx`

G 的其余 legacy notes 删除也由自动合并保留，没有复活旧实现或孤立测试。

## 门禁

在合并提交 `b69d1316` 上执行：

1. `npm ci`：通过，安装 1192 个包；npm 报告 12 个既有审计项
   （1 low、5 moderate、6 high），未运行会改动锁文件的自动修复。
2. `npm run version:generate && npm run typecheck`：通过。
3. `npm run build`：通过；Vite 转换 19733 个模块，仅输出既有循环 chunk、
   重复静态/动态导入和大 chunk warning。
4. `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml --lib`：
   通过，24 warnings、0 errors。
   - 本机默认 Cargo 1.83 无法解析锁定的 Rust 2024 依赖，改用与 CI 一致的
     stable Cargo 1.98。
   - 按 CI 安装 Linux Tauri 开发包，并用
     `bash scripts/download-pdfium.sh linux-x64` 准备 gitignored PDFium。
   - 下载脚本改写的 tracked license 文本已还原，工作树未留下生成改动。
5. 冲突热区测试：

   ```text
   npx vitest run \
     tests/vitest/mobile-uiux/deprecatedMobileHeaderBanContract.test.ts \
     tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts \
     tests/vitest/mobile-uiux/mobileHeaderViewRegistryContract.test.ts \
     tests/vitest/secondarySurfaceShellContract.test.ts \
     tests/vitest/data-governance/DataGovernanceDashboard.debug-tab-visibility.test.tsx \
     tests/vitest/settings/mcpToolsSectionGlobalBypassContract.test.ts \
     tests/vitest/settings/mcpToolsSectionBypassToggleContract.test.ts \
     tests/vitest/errorBoundaryCopy.test.tsx \
     tests/vitest/image-viewer-aria-label-i18n.source.test.ts \
     src/components/__tests__/QuestionBankListView.a11y.source.test.ts \
     src/components/__tests__/SecurityStatusIndicator.a11y.test.ts
   ```

   通过：11 files、38 tests。
