# 07 — 移动端 G / InputBar 拆分 / i18n 静态审计

- 审计代理：model=claude-fable-5-thinking-xhigh
- 审计对象：本枝 HEAD `9f1aa668`（基座 `origin/cursor/0824-cde6` @ `2d41ea8b` + 审计目录 README）
- 对照：`v0.9.44`（tag 本地在位，`git show` 逐文件对照）
- 方式：纯静态（源码 + locale JSON + 契约测试断言逐条对号；本环境无
  `node_modules`、无后台安装任务，符合本枝「只读静态审计」约定，未跑 vitest，
  运行期结论引用 `docs/0824-MERGE-PLAN.md` Step 8 / Step 21 已记录的门禁）。

---

## 1. G #172 底座：44px / safe-area / Android back

### 1.1 重放度计数红线（对照 Step 8 记录值）

| 计数项 | Step 8 记录（阈值） | 本次实测（HEAD） | 判定 |
| --- | --- | --- | --- |
| 含 `safe-area` 的文件数 | 68 ≥ 67 | **68**（`rg -l 'safe-area' src` = 68 文件；口径说明见下） | ✅ 持平 |
| `registerBackHandler` 出现次数 | 172 ≥ 166 | **172**（`rg -o` 全 src） | ✅ 持平 |
| `pointer:coarse` 出现次数 | 3056 ≥ 3032 | **4101** | ✅ 超集（Step 9+ 后续步继续加了热区） |

口径说明：Step 8 的「safe-area 68」按文件数复现吻合（`safe-area` 字符串在
src 内共出现 302 次、其中 `env(safe-area-inset` 98 次，均为超集方向，无回退）。

### 1.2 safe-area 链路（抽查全部命中）

- SSOT：`src/app/shell/mobileShell.ts:4-8` 定义四向
  `var(--android-safe-area-*, env(safe-area-inset-*, 0px))` 兜底链；
  `getMobileShellCssVars()`（同文件 37-46 行）统一导出
  `--mobile-safe-area-top/bottom/left/right` 与
  `--mobile-header-total-height`（headerHeight + 顶部安全区）。
- 顶栏消费：`src/components/layout/UnifiedMobileHeader.tsx:84-86`（compact 形态
  paddingTop/Left/Right 均叠安全区）与 `:118-121`（常规形态）。
- 抽屉/滑屏消费：`src/components/layout/MobileSlidingLayout.tsx:873-875`、
  `:893-897`（左缘 + 底部 `max(safe-area-bottom, keyboard-inset)`）、`:914`；
  `:669` 注释明确横屏挖孔机型的横向安全区约束。

### 1.3 Android back 链路（native → 协调器 → 注册方）

- native 侧：`src-tauri/mobile/android/MainActivity.kt:46-57` ——
  `OnBackPressedCallback` → `evaluateJavascript('window.__DEEP_STUDENT_HANDLE_BACK__()')`，
  JS 返回 false 时 `moveTaskToBack(true)`（退后台不杀进程，54/57 行）。
- JS 协调器：`src/app/navigation/androidBackCoordinator.ts` ——
  `BACK_PRIORITY`（overlay 100 / view 50 / navigation 0，30-37 行）、
  `registerBackHandler`（栈语义，53-60 行）、Radix 浮层 Escape 兜底选择器
  （67-73 行）、`installAndroidBackBridge`（157 行）。
- App 层 fallback：`src/App.tsx:91` 引入，`:1576-1589` 以
  `BACK_PRIORITY.navigation` 注册应用级历史 fallback。
- G 增量抽查（Step 8 裁决点逐个在位）：
  - `EpubPreview.tsx:78/91/148-156`：`isActive` 守卫——保活隐藏 tab 不注册，
    避免消费活跃视图的返回键（Step 8 曾指出 step5-fg 预演漏放该守卫，
    HEAD 已在位）；
  - `VideoPlayer.tsx:33/180`：全屏态注册返回键（退出全屏而非切视图）；
  - `DsDialog.tsx:264`：关闭钮 coarse 44px 锚定
    （`[@media(pointer:coarse)]:!h-11 !w-11 !top-0 !right-0`）+ `:504/523`
    AlertDialog 按钮 `!min-h-11`。

**小结：#172 底座三要素（44px / safe-area / Android back）在 HEAD 完整在位，
计数红线全部 ≥ Step 8 记录值。**

## 2. InputBar：F 拆分 Composer* 保持，G 热区叠加在拆分文件上

### 2.1 拆分保持（对照 v0.9.44 单体）

- v0.9.44 的 `InputBarUI.tsx` 为 **3919 行单体**（`git show v0.9.44:…` 实测；
  Step 8 记录为 3921，±2 行为统计口径差，不影响结论），且无
  ComposerToolbar / ComposerTextarea / AttachmentPanelBody。
- HEAD 相对 v0.9.44 **新增拆分文件**（`git ls-tree` 差集）：
  `ComposerToolbar.tsx`（934 行）、`ComposerTextarea.tsx`（323 行）、
  `AttachmentPanelBody.tsx`（401 行）、`attachmentModeHelpers.ts`、
  `inputBarConfig.ts`、`sendAvailability.ts`；`InputBarUI.tsx` 收缩到
  **2661 行**——未复活单体（Step 8 裁决 5 的红线）。
- 职责归属未回流：`ContextWindowUsageRing` 只存在于
  `ComposerToolbar.tsx:113`（`InputBarUI.tsx` 内 0 命中）；
  `InputBarUI.tsx:40-41` 引入 Overlay/Inline 两形态面板，移动端走内联插槽
  （`:2181` `ComposerInlinePanel`，`:2555-2559` 注释 + 桌面才渲染
  `ComposerPanelOverlay`）。
- 活跃面在 V2：`ChatContainer.tsx:327` 挂 `<InputBarV2`；旧
  `InputBar.tsx:4` 保留 `@deprecated Legacy` 注记，仅测试/迁移挂载点。
- `__tests__/InputBarV2.staleContextRef.test.tsx` 在位（Step 17 承诺保留）。

### 2.2 G 热区叠加（Step 8 裁决 5 的 8 处手工重放逐个对号）

- `ComposerToolbar.tsx`：
  - 发送钮 44px：`:66-67` `studyUiSendButtonSizeClass = 'h-11 w-11 … [@media(pointer:coarse)]:!h-11 !w-11'`，`:906` 应用于 `btn-send`；
  - 停止钮：`:876` `!w-8 !h-8 max-md:!w-11 max-md:!h-11 [@media(pointer:coarse)]:!w-11 !h-11`；
  - 命中扩区类：`:56-57` `coarseHitAreaLg/XlClass`（`after:-inset-2 / -inset-2.5`），`:617/:832` 应用；
  - 模型搜索框防 iOS 聚焦缩放：`:731` `[@media(pointer:coarse)]:!h-11 !text-base`。
- 水位环命中扩区：`ContextUsagePopover.tsx:90` `after:-inset-2`。
- `InputBarUI.tsx` 残留区 5 个提示按钮（longPaste convert `:2325` /
  dismiss `:2333`、flashcardHint `:2355`、mediaHint `:2377`、
  mindmapHint `:2397`）均带 `[@media(pointer:coarse)]:!h-11`。
- `AttachmentPanelBody.tsx`：移动加号钮 `:146` `!h-11 !min-w-11`、
  「⋯更多」钮 `:157` `!h-11 !w-11`、关闭钮 `:197`、菜单项
  `min-h-[44px]`（`:166/:174/:183`）、桌面区 + 重试/移除
  `[@media(pointer:coarse)]:!min-h-11` 共 **7 处**（`rg -c` 实测 = 7，
  恰好压契约下限 ≥7）。
- 契约测试锁定：`__tests__/InputBarUI.mobileSplitContract.source.test.ts`
  6 个用例（拆分归属 24-29 行、V2 活跃面 31-35 行、工具栏热区 37-47 行、
  附件面板 ≥7 处 49-52 行、提示按钮 ≥5 处 54-56 行、OCR 标签外置 58-62 行）
  逐条与上述源码对号，静态复核全部满足。

**小结：F 拆分未被 G 热区叠加破坏，Step 8「不复活整文件单体、8 处热区
手工重放进拆分文件」的裁决在 HEAD 全量成立。**

## 3. DataGovernanceDashboard = A tabs_nav_label + B E2EE zip + G 44px

源文件 `src/features/settings/components/DataGovernanceDashboard.tsx`：

- **A（可访问性 i18n）**：`:1809` `aria-label={t('data:governance.tabs_nav_label')}`
  挂在 TabsList；8 个 `TabsTrigger` 逐个带 aria-label
  （`:1812/:1816/:1820/:1824/:1828/:1832/:1836/:1843`，最后一个为 DEV-only
  debug 页签）。locale 复核：`data:governance.tabs_nav_label` +
  `tab_overview/recovery/archive/backup/sync/audit/cache` + `debug_tab_title`
  在 zh-CN / en-US **双语全部可解析**（脚本逐键实测 missing=none）。
- **B（E2EE zip）**：`:1103/:1135` `encryptionPassword` 贯穿
  `backupAndExportZip`；`:1171-1202` `exportZip`（含加密全保真导出注释 `:1170`）；
  `:1221/:1264` `importZip(zipPath, undefined, password)`；`:1881-1882`
  `onExportZip/onImportZip` 接线。
- **G（44px）**：8 个 trigger 全部
  `min-h-11 min-w-11 … sm:min-h-0 sm:min-w-0 [@media(pointer:coarse)]:!min-h-11 !min-w-11`
  （比 F×G 预演版多的 `!min-h-11 !min-w-11` 强制项在位，符合 Step 8 对
  step5-mobile `e7193f93` 终态的裁决）。
- 三方共存契约：`tests/vitest/data-governance/DataGovernanceDashboard.abg.source.test.ts`
  三个用例（A：8 trigger + aria-label + DEV 门 11-25 行；B：#177 API 上的
  encryptionPassword 27-38 行；G：44px 不挤掉 A/B 40-50 行）静态逐条复核满足。

## 4. Step 21：附件「⋯更多」必须 `t('common:more')`（不回退）

- 组件现状：`AttachmentPanelBody.tsx:158`
  `aria-label={t('common:more', { defaultValue: 'More' })}` ——
  **是 `common:more`，未回退成 `common:actions.more`**。✅
- 双锁在位、方向一致：
  - `src/__tests__/releaseUpgradeI18n.test.ts:58-62`：该文件
    keys=`['common:more']`、removedKeys=`['common:actions.more']`
    （禁组件源码引用旧键）；
  - `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts:100-112`：
    第三用例断言源码含 `aria-label={t('common:more'` 且
    `more` / `actions.more` / `actions.close` 三键双语可解析——与 Step 21
    收口裁决（适配提交 `be53b8ba`，其时 3/3 + 3/3 绿）逐字吻合。
- locale 侧按裁决**保留** `actions.more` 词条（removedKeys 只禁组件引用、
  不禁词条存在）：`zh-CN/common.json:86`（actions.more=更多）/ `:148`
  （顶层 more=更多）；`en-US/common.json:82` / `:144`。✅
- 全树消费者复核：组件代码中引用 `common:actions.more` 的为 **0 处**
  （全部 `aria-label` 走 `common:more`——FinderFileItem `:299/:346`、
  TabBar `:273`、LearningHubPage `:683`、MessageActions `:237`、
  ParallelVariantView `:747`、SkillsManagementPage `:1450`、
  SkillsList `:307`、QuestionBankManageView `:739/:890`、
  BatchOperationToolbar `:399`）；`actions.more` 仅存于两份 locale
  与上述两个测试文件。✅ 无第二个回退点。
- 该契约同时扫描 6 个拆分文件（contract test 22-29 行：InputBarUI /
  ComposerToolbar / ComposerTextarea / ComposerPlusMenu /
  AttachmentPanelBody / attachmentModeHelpers）的全部字面量命名空间键
  双语可解析——本审计未复跑测试，但抽查文件列表与正则均与 HEAD 源码结构匹配。

## 5. `sidebar:mobile_drawer.section_*` 缺键 —— v0.9.44 既有，仅记录

- 引用点：`src/components/layout/MobileSidebarNavigation.tsx:132-133`
  引用 `sidebar:mobile_drawer.section_study`（defaultValue '学习'）与
  `section_manage`（defaultValue '管理'）。
- locale 现状：`zh-CN/sidebar.json:13-16` 与 `en-US/sidebar.json:13-16` 的
  `mobile_drawer` 均只有 `section_app / section_chat / section_learning`，
  **缺 `section_study` / `section_manage`**（双语均缺）。
- 既有性验证：`git show v0.9.44` 下同一文件 132-133 行为**逐字相同**引用，
  v0.9.44 的 `zh-CN/sidebar.json` 亦只有同样三键 → **非 0824 回归**，
  是 v0.9.44 既有欠账。
- 影响面：en-US 用户在移动端抽屉分区标题看到中文兜底「学习」「管理」。
  按主代理指示**本轮只记录不强制修**；建议后续 i18n 批次补两键
  （补齐即可被 rel-mobile 式契约扫描覆盖，不需要改组件）。
- 附带扫描：同法扫 `UnifiedMobileHeader.tsx`、`MobileSlidingLayout.tsx`、
  `ComposerInlinePanel.tsx` 的全部字面量命名空间键——**全部双语可解析**；
  Step 8 提及的 `workbench:legacyFallback.desktopOnly` 亦双语在位。
  移动壳层缺键仅上述 2 个。

## 6. 测不到的部分（延续本枝约定）

- 未做 Tauri/Android 实机编译与真机返回键行为验证（MainActivity ↔ WebView
  桥只做了源码级对号）；未复跑 vitest（环境无 node_modules）。运行期绿灯
  引用 `docs/0824-MERGE-PLAN.md` Step 8 门禁表（input-bar 全目录 19 文件
  171/171、mobile-uiux 契约 42/42、DGD 6 文件 65/65）与 Step 21 门禁表
  （最终树 `be53b8ba` 上 typecheck / vite build / cargo check / 迁移检查
  全过，inputBarSplitI18nKeys 3/3 + releaseUpgradeI18n 3/3）。

---

## 结论

**PASS**（附 1 项既有问题记录，不构成 0824 回归）：

1. G #172 底座（44px / safe-area / Android back）完整在位，三项重放度计数
   ≥ Step 8 记录值（68 文件 / 172 次 / 4101 次）。
2. InputBar 保持 F 拆分（v0.9.44 3919 行单体 → HEAD 2661 行 + 6 个拆分新文件，
   未复活单体），G 的 8 处热区全部叠加在拆分文件上，拆分契约测试断言与
   源码逐条对号。
3. DataGovernanceDashboard 三方合成成立：A `tabs_nav_label` + 8 页签
   aria-label（双语键全可解析）、B E2EE zip（encryptionPassword /
   exportZip / importZip 贯穿）、G 每页签 44px 强制项，abg 契约锁定在位。
4. Step 21 裁决保持：附件「⋯更多」= `t('common:more')`（
   `AttachmentPanelBody.tsx:158`），`releaseUpgradeI18n` 与
   `inputBarSplitI18nKeys` 双锁方向一致，locale 保留 `actions.more` 词条，
   全树无其他旧键消费者。
5. 唯一缺陷：`sidebar:mobile_drawer.section_study/section_manage` 双语缺键
   （en-US 见中文兜底）——**v0.9.44 既有**，按约定仅记录，不强制修；
   建议列入后续 i18n 补键批次。

不需要本轮产品修复。**本轮不改代码**（本审计仅新增本 markdown，未触碰
任何产品代码 / locale / 测试文件，未执行任何 git 写操作）。
