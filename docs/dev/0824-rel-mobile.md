# 0824 移动端 UI/UX + 数据治理发版审查

## 范围与基线

- 候选：`origin/cursor/0824-cde6` tip `30fc858b`（fetch 后与预期一致）。
- 发版基线：`v0.9.44`（`1cf6cabc`）。
- 工作分支：`cursor/0824-rel-mobile-cde6`（独立 worktree，不触碰官方写手分支）。
- 审查主题：G 44px 热区 / safe-area / Android 返回键、Composer* 拆分、
  DataGovernanceDashboard（i18n `tabs_nav_label` + E2EE ZIP + 44px）、
  旧持久化状态升级路径、移动附件菜单。只修升级会坏的问题。

## 逐项审查结论

### 1. G 44px / safe-area / Android 返回键 — PASS

- **44px 热区**：治理 8 个页签全部带
  `[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11`
  （`DataGovernanceDashboard.tsx`，由 `DataGovernanceDashboard.abg.source.test.ts`
  锁定）；Composer 工具栏 / 附件面板 / 移动 “+” 菜单行高 ≥44px（由
  `InputBarUI.mobileSplitContract.source.test.ts` 锁定）；
  `AttachmentPreviewChips` 本轮为 coarse pointer 增加 `!min-h-11` 且
  partial 态补上 44px 重试入口。44px 全部由 CSS 媒体查询驱动，
  不依赖任何持久化开关。
- **safe-area**：`src/app/shell/mobileShell.ts` 自 v0.9.44 起零改动，
  `--android-safe-area-*` 回退 `env(safe-area-inset-*)` 链完整；
  `mobileShellContract.test.ts` 通过。移动端 Composer 内联面板高度用
  `--keyboard-inset` 约束，键盘弹起不顶出屏幕。
- **Android 返回键**：`androidBackCoordinator.ts` 相对 v0.9.44 仅有一处
  **纯新增** `hasOpenRadixOverlayBesides()`——供“自身即 Radix dialog 的
  全屏容器”（移动端 Settings Sheet）让行给更上层浮层；优先级/栈语义、
  Radix Escape 兜底探测均未变。`Settings.tsx` 的 sheet handler 以 overlay
  档注册并 gate `isActive`；`InputBarUI` 在 `isMobile && hasAnyPanelOpen`
  时注册 overlay 档 handler 先关组合面板；App 层 fallback 在无历史且不在
  chat-v2 时先回主视图。`appNavigationFallback.test.ts` 通过。

### 2. Composer* 拆分未倒回 — PASS

- `InputBarUI.tsx` 保持 import `ComposerToolbar` / `ComposerTextarea` /
  `AttachmentPanelBody`；`ContextWindowUsageRing` 归属 `ComposerToolbar`；
  `sendAvailability.ts` / `inputBarConfig.ts` / `attachmentModeHelpers.ts`
  独立模块在位。`InputBarUI.mobileSplitContract.source.test.ts` 全绿。

### 3. DataGovernanceDashboard — PASS（含本轮外围修复）

- **i18n**：`data:governance.tabs_nav_label` 与 8 个 tab 标签、
  `restore_partial_archive_refused` / `import_sealed_password_required` /
  `import_sealed_decrypt_failed` / `restore_atomic_unavailable`、
  `cloudStorage:errors.*`（sealed/atomic/partial）在 zh-CN 与 en-US
  **两份 locale 均在**。治理面板范围内 866 个字面量键扫描无缺失。
- **E2EE ZIP**：`encryptionPassword` 贯穿
  `backupAndExportZip` / `exportZip` / `importZip`（`src/api/dataGovernance.ts`
  三个签名均已带可选密码位）；BackupTab 密码输入带 8 字符校验与
  coarse-pointer 44px；`isImportedArchiveSlotRestorable` 拦截便携/部分归档
  的整槽恢复弹窗；catch 路径统一走 `localizeCloudStorageError`，
  job 错误走 `localizeBackupJobError`，sealed 三态均有稳定 code 映射。
- **Debug 页签**：生产隐藏（`import.meta.env.DEV`），外部深链
  `tabTarget.tab === 'debug'` 在生产被丢弃，不会切到空页签。

### 4. 旧 persist 升级路径 — PASS（热区/返回键/治理 tab 均不会空白）

- **治理 tab**：`activeTab` 是组件内 `useState('overview')`，从不持久化；
  深链经非持久化的 `settingsShellStore` 归一化（`trash`→`archive`，
  未知值直接丢弃）+ 生产 debug 守卫，不存在“指向已消失页签→空白”的路径。
- **返回键**：handler 注册表是纯运行时结构，无持久化输入。
- **44px 热区**：CSS `[@media(pointer:coarse)]`，与持久化无关。
- **Composer 持久化状态**（后端 per-session UI state，v0.9.44 载荷）：
  `normalizeRestoredComposerState` 补默认键、丢弃退役 rag/search/learn 键与
  畸形值后才交给拆分组件（`restoreActions.ts:705`，
  `composerStateMigration.test.ts` 锁定）。
- **`dstu-ui-store`**：version 1 + 防御性 `migrate`，任意旧形状可恢复。
- **workbench 快照**：`DISPLAY_MODES` 仅新增 `tiled-top/bottom`
  （additive），v0.9.44 持久化值全部仍合法。
- **`desktop.workbenchMode`** localStorage 预读：`!== 'false'` 判定，
  v0.9.44 无该键 → 默认启用，与 `resolveWorkbenchModeEnabled` 的
  缺失键迁移哨兵语义一致。

### 5. 移动附件菜单 — 发现 1 个升级引入缺陷，已修

- `ComposerPlusMenu` 移动端单层扁平列表（44px 行高、拍照入口按
  `isMobileEnv && onOpenCamera` 双重 gate、技能/连接器跳内联面板）符合设计。
- **BUG（升级引入）**：`AttachmentPanelBody.tsx`（v0.9.44 后新增）移动端
  「⋯ 更多」按钮 aria-label 引用 `t('common:actions.more', '更多')`，
  该键在两份 locale 均不存在——en-US 读屏（TalkBack/VoiceOver）只能听到
  中文 fallback「更多」。

## 修复

1. `fix(i18n)`：在 `zh-CN/common.json` 与 `en-US/common.json` 的 `actions`
   对象补 `"more": "更多"` / `"more": "More"`（提交 `1901780e`）。
2. `test(mobile)`：新增
   `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts`——
   扫描拆分 Composer 组件全部字面量带命名空间的 t() 键，断言 zh-CN 与
   en-US 同时可解析，并单独锁定附件面板 more/close aria-label
   （提交 `8c7f8415`）。

## 发现但未修（v0.9.44 已存在，非升级引入）

- `MobileSidebarNavigation.tsx:132-133` 引用
  `sidebar:mobile_drawer.section_study` / `section_manage`，两份
  `sidebar.json` 自 v0.9.44 起就只有 `section_app/chat/learning` 三键——
  en-US 用户的 F1 抽屉分组标题经 fallback 显示中文「学习」「管理」。
  该文件与 locale 在本次发版区间零改动，升级不引入也不加重；
  建议后续 i18n 轮补 2 键（零风险）。

## 不变量核对

- Composer* 拆分：在位（见第 2 节）。
- 附件 200MB / 图片 50MB：`constants.ts` `ATTACHMENT_MAX_SIZE=200MB`、
  `ATTACHMENT_IMAGE_MAX_SIZE=50MB`；`resources/types.ts` 200/50 同步在位。
- G 44px / safe-area / Android back：在位（见第 1 节）。
- HPIAS：`researchStore.ts` 仍挂 `hpiasSessionSlice`（会话隔离）。
- 闪卡只读：`src/features/generative-ui/**` 无
  `save_to_library` / `saveToLibrary` 命中。

## 验证

- 首轮定向 Vitest（拆分输入栏 / composer 迁移 / mobile-uiux / 治理 debug
  可见性 / localizeCloudError / zip-password / mobileShell / 导航
  fallback）：30 files, 230 tests 全绿（`@/version` 需先
  `npm run version:generate`，属测试环境准备，非产品缺陷）。
- 新增契约测试：3 tests 全绿。
- 终轮全量门（mobile-uiux + data-governance 全目录 + input-bar 全部 +
  composer 迁移/panels + mobileShell + appNavigationFallback）：
  **71 files / 691 passed + 5 todo，0 失败**（修复提交之后运行）。

## 结论

**TAKE**。升级引入的唯一缺陷（移动附件面板 more 按钮 en-US aria-label
回落中文）已修并加契约测试；其余审查项全部 PASS，旧持久化状态不会造成
热区失效、返回键失灵或治理页签空白。
