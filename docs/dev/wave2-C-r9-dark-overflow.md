# 0824 Wave2-C R9：暗色 / 字号缩放 / 窄屏溢出残项

日期：2026-08-26（UTC）

## 结论

- **产品 diff：有。**
- 暗色：本会话移动 chrome 未发现会破坏主题 token 的硬编码
  `hex` / `bg-white` / `text-black`，本轮没有为了交差改颜色。
- 字号：修复移动壳、AppMenu、Composer 明显小字和 Settings / Learning Hub
  移动 chrome 中不参与 `--font-size-scale` 的字号。
- 溢出：Settings 数据治理剩余三张窄屏宽表改为 `<md` 卡片列表；
  AppMenu 高度跟随 live visual viewport，长菜单不再滚出软键盘后的可视区。
- 触控：FolderPicker 非 button 树行改走 `TouchTarget`，图标动作回归
  `DsButton` primitive，硬布局中的 28px 笔记属性入口改走共享 `coarseHit`；
  没有新增 `!min-h-11` 或散点 `44px`。

## 扫描范围

1. Composer 移动热区：
   `src/features/chat/components/input-bar/**`；字号只处理
   `ComposerPlusMenu.tsx` 内移动端实际显示且低于 caption 地板的小字，
   未把目录已有 `no-arbitrary-font-size` warning 展开成散点大改。
2. mobileShell：
   `src/app/shell/mobileShell.ts`、`src/components/layout/*Mobile*`、
   `UnifiedMobileHeader.tsx`。
3. AppMenu 移动：
   `src/components/ui/app-menu/AppMenu.tsx` / `AppMenu.css` / `AppSelect.tsx`。
4. eslint-rules / check-i18n：
   `eslint-rules/*.js`、allowlist、`eslint.config.js`、
   `scripts/check-i18n.mjs` 及已有 source tests。
5. Learning Hub / Settings 移动 chrome：
   统一顶栏、移动工具栏、子屏、FolderPicker、QuickLook、Settings sheet，
   以及台账已登记的 Settings 数据治理窄屏宽表。

## 产品改动

### 字号缩放

- `UnifiedMobileHeader`：标题 `text-[15px]` → `text-md`；副标题
  `text-[11px]` → 移动 caption token。
- `Settings`：移动分组标题、列表标题/说明改为 `text-md` / `text-lg` /
  `text-ui`；sheet 标题 CSS 改用 `--font-size-xl`；公共移动说明改用
  `text-md`。
- `LearningHubSidebar`：移动搜索输入保留 iOS 16px floor，同时接入
  `--font-size-lg`；截断提示改用 caption token。
- `ComposerPlusMenu`：仅将移动端会显示的 10/11/12px 权限状态、提示和
  AppMenu 标签改为 `text-caption`，未动其余 input-bar 字号存量。
- `AppMenu.css`：固定 10/11/12/16px 字号改接字体 token；移动端标签/
  说明统一加 `--m-text-caption` 可读地板；搜索框使用 16px floor +
  `--font-size-lg`。

### 窄屏溢出 / coarse 可达

- `AppMenu`：
  - 主菜单和子菜单把 visual viewport 可用高度写入
    `--app-menu-available-height`；`<640px` 超高内容纵向滚动并限制
    overscroll。
  - 默认 hover 子菜单在 `(pointer: coarse)` 下自动切为 click 打开；
    桌面 fine pointer 继续保留 hover。
- `SyncTab` / `AuditTab` / `OverviewTab`：
  - `md+` 保留原表格；
  - `<md` 渲染不横滑的卡片列表，复用原数据、状态徽标和空态；
  - 未改同步、审计、健康检查或存储后端逻辑。
- `FolderPickerDialog`：两类 treeitem 行通过 `TouchTarget asChild` 获得
  coarse 实体盒；展开按钮、返回/确认按钮由 `DsButton` 基座保证触控，
  删除 `min-h-[44px]`、`!h-11`、`!min-h-[44px]` 和负 margin 补丁。
- Learning Hub 移动工具栏 / canvas chrome / 顶栏动作：
  图标动作改用 `DsButton size="icon" iconOnly`；桌面视觉 h-6/h-7 保留，
  coarse 最小命中由 primitive 统一提供。
- `NoteContentView`：固定 28px 工具栏入口改引用
  `coarseHitClassFor28`；其余 DsButton 删除重复 coarse 强制类。

## 暗色检查

- mobileShell、AppMenu 外壳、Learning Hub / Settings 移动 chrome 均使用
  `--menu-shell-*`、`--shell-*`、`bg-background`、`surface` 或语义色 token。
- 扫到但判定不属于 chrome 违规的颜色：资源类型插画 palette、EPUB 阅读
  主题 palette、媒体播放蒙层、二维码白底；这些都是内容/品牌渲染，不改。
- 未发现需要安全产品修复的暗色 diff。

## eslint-rules / check-i18n

- `check-i18n` 是 Node 检查脚本，无移动颜色、字号或布局输出；本轮静态扫描
  未发现与本任务口径相关的产品问题，未修改。
- `coarse-touch-target` allowlist loader 在本轮工作区已有另一并行席位的
  未提交修改及独立报告 `wave2-C-r9-lint-loader.md`；为避免同文件冲突，
  本席不覆盖其改动。该报告已确认旧的非 `file:` 收集异常解除，但
  ESLint 9 RuleTester 配置仍使专测未绿。

## 越权通报

### 给 B：桌面 Composer

- `ComposerPanel/ComposerPanel.tsx`、`ModelPicker.tsx` 等混合/桌面内容仍有
  `text-[11px]` / `text-[12px]` 存量；按本轮“不要把 input-bar warn
  扫成散点大改”及桌面所有权边界未动。
- `ComposerPanelOverlay.tsx` 本轮模式扫描未发现新增硬色或横向溢出命中。

### 给 E：anki / qbank

- `src/features/anki-tasks/AnkiTasksApp.tsx`、`SessionRow.tsx`、
  `QuestionBankManageView.tsx` 仍有大量 10/11/12/13px 任意字号。
- `SessionRow.tsx` 的卡片明细仍用横向 `CustomScrollArea` +
  多列 `min-w-[100px]`；属于窄屏宽表同类残项。
- `QuestionBankManageView.tsx` 仍有 coarse
  `!min-h-[44px]` / `!min-w-[44px]`。以上仅登记，未改 anki/qbank 域。

### 给 D：coordinator

- `src/app/navigation/androidBackCoordinator.ts` 无颜色、字号或布局命中；
  本轮未改优先级、排序、可见性守卫或 native bridge。

## 定向验证

- `git diff --check`（仅本席文件）：通过。
- 定向 ESLint（13 个产品文件）：**0 error**；warning 为既有
  event-listener / native-button / hooks 及不在移动分支内的存量。
- 定向 Vitest：AppMenu keyboard + visualViewport、FolderPicker source、
  Settings mobile cards，共 **4 files / 28 tests passed**。
- 未运行全库编译、全量 lint、全量 Vitest、Vite/Cargo/migrations。
- 未 commit、未 push。

模型降级：否；本运行内无法独立读取 `xhigh-fast` 子档位标签，未触发
`gpt-5.6-sol-high-fast` 降级。
