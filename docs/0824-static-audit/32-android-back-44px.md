model=claude-fable-5-thinking-xhigh

# 32 — G 全链路深挖：44px / safe-area / Android back（对照 v0.9.44）

- 审计对象：本枝 HEAD `3e1da02f`（基座 `origin/cursor/0824-cde6` @ `2d41ea8b`）
- 对照基线：`v0.9.44`（tag 本地在位 `1cf6cabc`，`git diff` / `git grep` / `git show` 只读对照）
- 方式：纯静态深挖。07 号稿已给 G 底座骨架与计数红线，20 号稿已给 F×G / A×B×G
  叠加；本稿职责是把三条链**逐环节拆到 native ↔ JS ↔ 组件**并对 v0.9.44 做
  逐文件差异归因（不是复读 07/20 的计数，重叠处只交叉引用）。
- 未跑 vitest / 未做 Tauri 实机编译（本枝「只读静态审计」约定）；运行期绿灯
  引用 `docs/0824-MERGE-PLAN.md` 既有门禁记录。

---

## 1. Android back 全链路（native → 桥 → 协调器 → 注册方）

### 1.1 native 层：相对 v0.9.44 零变化

`src-tauri/mobile/android/MainActivity.kt`（受控副本，`git ls-tree` 确认为
src-tauri 下唯一 MainActivity）：

- `:46-61` `OnBackPressedCallback` → `evaluateJavascript` 调
  `window.__DEEP_STUDENT_HANDLE_BACK__()`，整段包 `try/catch` 且函数缺席时
  返回 `false`；结果非 `"true"` → `moveTaskToBack(true)`（`:56-58`）；
  WebView 尚未就绪时直接 `moveTaskToBack(true)`（`:49-51`）。任何 JS 异常
  都不会把返回键吞死，最坏退后台、不杀进程。
- **对照结论**：`git diff v0.9.44..HEAD -- MainActivity.kt` 共 +99 行，
  **全部**是 SAF `takePersistableUriPermission` 持久化队列
  （`persistPendingSafUri` / `persistQueuedSafFile` / `onPause` 轮询管理，
  `:31-37/:102-110/:112-173/:190-195`），与返回键、安全区两条链**互不触碰**
  ——back 回调与 inset 监听两段逐字未动。SAF 队列属云同步/导出域，
  已在 02/26 号稿范围，此处只确认「同文件增量不污染 G 链」。

### 1.2 桥安装与协调器分发：分发逻辑逐字同 v0.9.44

- 桥安装：`src/App.tsx:1567` 挂载 effect 里 `installAndroidBackBridge()`；
  协调器 `src/app/navigation/androidBackCoordinator.ts:157-159` 把
  `handleAndroidBack` 挂到 `window.__DEEP_STUDENT_HANDLE_BACK__`。
- 分发顺序（`androidBackCoordinator.ts:110-148`）：显式 handler 按
  priority 降序 + 同档 seq 降序（栈语义，`:116`）；Radix Escape 兜底探测
  **夹在 overlay 档与更低档之间**（`:127-129`，首个 `priority < 100` 的
  handler 之前探测一次），循环后对「全 overlay 档/空栈」补跑（`:141-144`）；
  handler 抛异常被 catch 并继续（`:131-138`）；全不消费返回 `false` →
  native `moveTaskToBack`。
- 兜底选择器 `OPEN_OVERLAY_SELECTOR`（`:67-73`）仅匹配
  dialog/alertdialog/popper 内 menu/listbox/dialog 五类，避免误伤
  accordion 等非浮层 `data-state`。
- **对照结论**：`git diff v0.9.44..HEAD` 该文件仅 +16 行 =
  新导出 `hasOpenRadixOverlayBesides(excluded)`（`:83-89`，判定 excluded
  之外是否还有打开中的 Radix 浮层）；`BACK_PRIORITY`（overlay 100 / view 50 /
  navigation 0）、栈语义、探测位置、异常兜底**逐字未变**。

### 1.3 注册面：81 文件 / 172 次，v0.9.44（59 / 128）的严格超集

统一排序后求文件集差（`rg -l` vs `git grep -l`）：

- **零删除**：v0.9.44 有 handler 的 59 个文件在 HEAD 全部保留。
- **新增 22 个注册文件**（0824 增量，按域归类）：
  - 自绘浮层补注册（Radix 兜底探不到、v0.9.44 中返回键会穿透）：
    `components/ui/shad/Popover.tsx:52-58`（通用 Popover，打开时 overlay 档
    注册、与 Escape 同一关闭路径）、`components/crepe/plugins/imageLightbox/lightboxDom.ts:253-256`、
    `features/chat/components/input-bar/ModelMentionPopover.tsx` /
    `SkillSlashPopover.tsx`、`chat/components/message/MessageTouchActionBar.tsx:86`、
    `chat/components/MessageSearchBar.tsx`、`chat/plugins/blocks/components/CitationPopover.tsx`、
    `components/skills-management/SkillTapBrowser.tsx`、
    `features/workbench/apps/preview/quickLook.tsx:123`、
    `shared/notes/useSaveAsNoteFlow.tsx`；
  - 视图内导航/全屏态：`learning-hub/apps/views/ExamContentView.tsx`、
    `apps/views/media/VideoPlayer.tsx:178-186`（仅全屏时注册，back=退全屏）、
    `learning-hub/views/IndexStatusView.tsx`、`notes/components/NotesEditorHeader.tsx`、
    `pdf/components/PdfSelectionActions.tsx`、`sandbox/components/SandboxWorkbenchSurface.tsx`、
    `todo/components/main/detail/TagsEditor.tsx`；
  - 设置子面：`settings/components/McpToolsSection.tsx`、
    `OpenSourceAcknowledgementsSection.tsx`、`plugins/PluginsTab.tsx`；
  - 测试：`pdf/components/__tests__/pdfSelectionToolbar.source.test.ts`
    （`:105` 锁 PdfSelectionActions 源码必须含 `registerBackHandler`，
    `:99` 同文件锁 safe-area 派生变量——G 链新增的防回退锁）。
- 出现次数 128 → 172（+44），与 07 号稿「≥166 红线」口径一致；
  调用点（`registerBackHandler(`）92 处（含协调器内定义 1 处）。

### 1.4 优先级分布：navigation 档全树恒为 1

`BACK_PRIORITY.*` 字面量分布（rg -o，含注释）：

| 档位 | v0.9.44 | HEAD | 说明 |
| --- | --- | --- | --- |
| overlay | 61 | 85 | 全部增量落在 overlay 档（浮层补注册） |
| view | 8 | 8 | 7 个调用点 + 1 处注释；成员变化见 1.5 |
| navigation | 1 | 1 | **仅 `App.tsx:1589`** 全局 fallback，无第二注册方 |

App 级 fallback（`App.tsx:1575-1590`）与 v0.9.44 **逐字相同**（连行号都相同）：
有统一历史则 `goBack`；小屏且不在 chat-v2 时回主视图（F1「进得去就出得来」，
与 `tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts:114-120`
「每个 CurrentView 三桶可达」互为表里）；否则返回 false 交还 native 退后台。

### 1.5 相对 v0.9.44 的唯一行为级差异：Settings 返回档位修复（正向）

- v0.9.44：`Settings.tsx:584-593` 两级回退 handler 注册在 **view 档**。
  但协调器（v0.9.44 与 HEAD 同一份分发逻辑）在进入 view 档前必跑 Radix
  Escape 兜底，而移动端 Settings 整页就是 Radix Sheet
  （`role="dialog" data-state="open"`）**常驻命中探测**——静态推演下
  v0.9.44 的该 view 档 handler 永远轮不到：返回键会派发 Escape 直接关掉
  整个 Sheet，跳过「供应商详情 → 列表 → 分区内容 → 分区列表」逐级回退。
- HEAD：`Settings.tsx:571-599` 改注册 **overlay 档** + `isActive`/小屏门
  （`:587`），并用新 helper `hasOpenRadixOverlayBesides(sheetContentRef)`
  （`:589`）在自身之上还叠着未显式注册的 Radix 浮层（shad/Select 下拉等）时
  返回 false 让行，交兜底先关最上层浮层；分区列表态返回 false → 兜底 Escape
  → Sheet 关闭，作为回退链最后一级。层级语义「先关浮层再退页面」闭环。
- 定性：这是 0824 相对 v0.9.44 的 **bug 修复而非回归**（v0.9.44 移动端
  Settings 返回键一键关整页）。1.2 的 +16 行 helper 即为此服务，全树唯一
  消费者就是 `Settings.tsx:29/:589`。属静态推演，真机行为见 §4。

### 1.6 保活/卸载守卫抽查（新增注册方无泄漏）

- 保活视图门：`EpubPreview.tsx:150-156` `!isActive` 不注册（隐藏 tab 不吞
  活跃视图返回键）；`Settings.tsx:587` 同款 `isActive` 门；
  `TemplateManagementApp.tsx:760-781` 两个 view 档 handler 以
  `el.isConnected + getClientRects().length + visibility` 做 DOM 级可见性
  守卫；`LearningHubPage.tsx:762-768` `!active || !canGoUp` 返回 false。
- React 侧全部走 `useEffect(() => registerBackHandler(...))` 返回注销函数
  （Popover `:52-58`、DsDialog `useAndroidBackClose` `:21-31`（ref 稳定注册，
  避免回调变化注销重注破坏栈序）、VideoPlayer `:178-186` 等）；
  唯一命令式注册方 `lightboxDom.ts:253` 与 `closeImageLightbox` 内
  `unregisterBack()`（`:100-103`）成对，关闭即注销。未发现悬挂注册。

## 2. safe-area 全链路（WindowInsets → 注入 → CSS 变量 → 消费者）

### 2.1 native 注入端：相对 v0.9.44 零变化

`MainActivity.kt`：`:40` `enableEdgeToEdge()`；`:67-82`
`setOnApplyWindowInsetsListener` 取 `systemBars() or displayCutout()` 四向
inset，按 density 换算 CSS px；`:175-188` 注入 JS——目标函数未就绪时落
`__DEEP_STUDENT_PENDING_SAFE_AREA__` 暂存；`:92-95` WebView 创建后首帧 +
500/1500/4000ms 三次补发（覆盖冷启动页面替换窗口）；`:98-101` `onResume`
重注入（页面重载后 JS 端退回 fallback 的自愈）。以上与 v0.9.44 逐字一致。

### 2.2 JS 应用端：相对 v0.9.44 零变化

`src/utils/platform.ts`（不在 v0.9.44 diff 中）：`:111-149`
`initAndroidSafeArea` 先写固定 fallback（top 24 / bottom 15），安装
`__DEEP_STUDENT_SET_SAFE_AREA__`（`:139`），优先消费暂存值（`:141-146`）；
`applySafeArea` 对四向做 `0..200` clamp 取整（`:119-123`）后写
`--android-safe-area-*` 与 `--safe-area-inset-*-fallback`（`:125-133`）。
`index.html:7` `viewport-fit=cover` 双版本逐字相同。

### 2.3 SSOT 与消费者

- SSOT `src/app/shell/mobileShell.ts`：**对 v0.9.44 零 diff**。四向
  `var(--android-safe-area-*, env(safe-area-inset-*, 0px))` 兜底链（`:4-8`，
  Android 真实注入优先、iOS/未注入回落 env、再落 0px），
  `getMobileShellCssVars()`（`:37-46`）导出 `--mobile-safe-area-*` 与
  `--mobile-header-total-height`。
- 消费抽查：`UnifiedMobileHeader.tsx:84-86/:118-121`（compact/常规两形态
  顶部+横向全叠）；`MobileSlidingLayout.tsx:887-897` 抽屉左缘叠
  `--mobile-safe-area-left`、底部
  `max(var(--mobile-safe-area-bottom), var(--keyboard-inset))` 同时避让
  手势条与软键盘——`--keyboard-inset` 的全局基线由 `App.tsx:1571`
  `ensureKeyboardTracking()`（`useKeyboardHeight.ts:38/:142`）在壳层建立，
  不依赖首个输入组件挂载。

### 2.4 相对 v0.9.44 的增量：壳外恢复页全局兜底（正向）

`git diff v0.9.44..HEAD -- src/styles/ios-safe-area.css`（+6 行）：在
`:root` 补 `--mobile-safe-area-*` 全局定义（同 SSOT 兜底链），注释明示
「App shell 外的恢复页也会消费 mobile shell 契约；壳内
`getMobileShellCssVars()` 继续按局部树覆盖」。对应 safe-area 文件数
66 → 68 的两个新增消费者：`features/data-recovery/RecoveryShell.tsx:35-43`
（挂在 App shell 之外的恢复壳，顶栏 `calc(3rem + safe-area-top)`）与
`ComponentRecoveryShell.tsx`。级联语义正确：全局 `:root` 定义只是兜底，
壳内局部内联样式特异性更高、照常覆盖。

### 2.5 文件差集全核（无回退）

safe-area 文件集差（66 → 68）逐项归因：新增 = 上述恢复页两件 + PDF 工具栏
source 测试（1.3 已述）；**唯一消失项** `features/notes/NotesHome.tsx` 为
整文件删除（`git log`：`92d448c2 fix(mobile): raise mindmap hit targets and
drop dead notes chrome`，死代码清理），非消费点回退。
`env(safe-area-inset` 86 → 98 次，超集方向。

## 3. 44px 全链路（令牌 → 媒询 → 组件锚点 → 测试锁）

### 3.1 令牌与全局工具类

- `src/styles/shadcn-variables.css:41-42`：`--control-height-touch: 44px`、
  `--touch-target-size: var(--control-height-touch)`（单一数值源）。
- `src/styles/responsive-utilities.css:30-33`：`.touch-target`
  `min-height/min-width: 44px !important`（仅显式标记者，避免曾把全 Android
  按钮撑坏的全局注入——文件头 `:15-17` 注释留痕）；`:159` `.touch-row`
  `min-height: var(--control-height-touch, 44px)`。
- Tailwind：`tailwind.config.js` 未覆盖 spacing 11 档 → `h-11/min-h-11` =
  默认 2.75rem = 44px，全部 `[@media(pointer:coarse)]:!h-11` 锚点口径成立。

### 3.2 媒询口径变化：`(hover:none) and (pointer:coarse)` → `(pointer:coarse)`（正向放宽）

`responsive-utilities.css` diff：两处触控块媒询去掉 `hover: none` 前置条件
——带鼠标/触控笔的混合设备（触屏笔记本等）`hover:none` 为假但触控真实存在，
v0.9.44 口径下这些设备拿不到 44px 热区与抽屉触控字号。同 diff 内抽屉字号从
定值改 `max(14px/16px, var(--font-size-*))`（跟随界面字号缩放但不跌破移动
可读地板；16px 同时是 iOS WKWebView 聚焦缩放地板），并删除 `.rct-tree` 两条
死规则（笔记树抽屉块随 `92d448c2` 清理）。残留 `(hover:none) and (pointer:coarse)`
的 5 个文件（scrollbars/flashcards/library/settings.css/TextContextMenu）
均为 **hover 压制语义**（触屏禁 hover 残留），且 v0.9.44 同款存在
（10 → 5 文件，另 5 件已迁纯 coarse），非热区门槛、非回归。

### 3.3 计数对照（全部超集方向）

| 计数项 | v0.9.44 | HEAD | 判定 |
| --- | --- | --- | --- |
| `pointer:coarse` 出现次数（src） | 974 | 4101 | ✅ 超集（07 号稿红线 ≥3032 之上） |
| `[@media(pointer:coarse)]` 出现次数 | 962 | 4079 | ✅ 超集 |
| `registerBackHandler` 出现次数 | 128 | 172 | ✅ 超集（红线 ≥166） |
| safe-area 文件数 | 66 | 68 | ✅ 超集（差集已逐项归因 §2.5） |

### 3.4 组件锚点与测试锁（交叉引用，不复读）

- 自绘弹窗：`DsDialog.tsx:264` 关闭钮 coarse 下 `!h-11 !w-11 !top-0 !right-0`
  （视觉 24px、命中 44px），`:504/:523` Alert 按钮 `!min-h-11`——与同文件
  `useAndroidBackClose`（§1.6）构成「44px + back」双要素同居一文件的样板。
- Composer/附件/DGD 页签锚点及其契约（发送钮 44、附件 ≥7 处 coarse、DGD
  8 页签 44px 不挤掉 A/B）已由 07 号稿 §2-3 与 20 号稿 §一/§二 逐行核过，
  本稿不重复；本轮新增的锁是 `pdfSelectionToolbar.source.test.ts`
  （back + safe-area 同锁，§1.3）。
- `UserAgreementDialog.visibility.test.tsx:10` mock `registerBackHandler`
  返回注销函数——测试侧承认「注册必返回注销」的接口契约。

## 4. 测不到的部分（延续本枝约定）

- 未做 Android 实机验证：`moveTaskToBack` 行为、WindowInsets 旋转/手势导航
  切换时序、§1.5 Settings 档位修复的真机逐级回退、混合设备 coarse 媒询命中，
  均为源码级对号 + 静态推演。
- 未复跑 vitest（环境无 node_modules）；协调器分发逻辑本身无独立单测
  （v0.9.44 亦无，非回归），其行为由 native 桥 + 各注册方契约测试间接锁定。

---

## 结论

**PASS（G 全链路相对 v0.9.44 无回归；含 1 项正向行为修复、0 项新欠账）**：

1. **Android back**：native 回调、JS 桥、协调器分发逻辑相对 v0.9.44
   逐字未变（MainActivity +99 行全部是与 G 无关的 SAF 队列；协调器 +16 行
   仅新增 `hasOpenRadixOverlayBesides`）；注册面 59→81 文件 / 128→172 次
   **严格超集、零删除**；navigation 档全树恒为 1（App.tsx 全局 fallback
   逐字同 v0.9.44）；新增 22 个注册方全部带打开态/激活态门并成对注销。
2. **唯一行为级差异是修复不是回归**：v0.9.44 移动端 Settings 的 view 档
   返回 handler 被自身 Sheet 常驻命中的 Radix 兜底探测遮蔽（静态推演下
   返回键一键关整页）；HEAD 改 overlay 档 + `hasOpenRadixOverlayBesides`
   让行守卫，恢复逐级回退且维持「先关浮层再退页面」。
3. **safe-area**：native 注入（edge-to-edge + WindowInsets + 三次补发 +
   onResume 自愈）与 JS 应用端（clamp + fallback + 暂存消费）双端相对
   v0.9.44 零变化；SSOT `mobileShell.ts` 零 diff；增量仅「壳外恢复页
   `:root` 兜底 +6 行」与两个恢复页消费者，文件差集内唯一消失项是
   死文件删除（`92d448c2`），非消费点回退。
4. **44px**：令牌单源（`--control-height-touch: 44px`）、Tailwind 11 档
   未被覆盖、coarse 媒询从 `hover:none and coarse` 放宽为纯 `coarse`
   （混合设备受益，残留 hover:none 块均为既有 hover 压制语义）；
   `pointer:coarse` 974→4101 全超集；组件锚点与契约锁由 07/20 号稿
   已核，本稿新证 PDF 工具栏 source 测试把 back + safe-area 一并上锁。

不需要本轮产品修复。**本轮不改代码**（本审计仅新增本 markdown，未触碰任何
产品代码 / locale / 测试文件，未执行任何 git 写操作）。
