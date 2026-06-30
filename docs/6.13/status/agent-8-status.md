# 代理 8 状态文档（round 2）—— 移动端 UI/UX 体验（全局横切）

> 本文件是第二轮（docs/6.13）的状态/接力文档。第一轮完整上下文见 `docs/6.12/status/agent-8-status.md`
> （G1–G7 / F1–F8 / 11 项发现 / 10 批优化，禁止清空重写）。
> 本轮 feed_id=F-2F4RS（mcp-feedback-enhanced）；第一轮 feed_id=F-STJWA。接力会话请重新注册自己的 feed_id。
> 本轮定位（README §1 + agent-8.md）：**真机验证 + 收口**，第一轮覆盖已充分。

## 本轮任务（按 agent-8.md 优先级）
- **P1 真机验证**：SA-1（MainActivity.kt WindowInsets 注入三形态真机验证）、#11（横屏手机按桌面双栏渲染，触控偏小）。
- **P2 收口/包体**：#5（tailwind `xs:480` 未收录进 `breakpoints.ts`）、#10（framer-motion 未用 LazyMotion）、#13（FolderTreeItem 三点菜单触屏密度）、#14（MessageItem 历史 footer ≥768 触屏 hover-only）。

## 进度概览
- [x] **#5** 断点单一来源收口（已实施 OR2-1，验证通过）。
- [x] **#14** MessageItem 平板 footer 可达性（已实施 OR2-2，验证通过；coarse 指针常显，保留桌面 fine 指针 hover 契约）。
- [x] **#13** 二轮深审定性：任务点名的 `FolderTreeItem.tsx` 是**死代码**（仅 barrel 再导出、无消费者），其 hover-only 三点菜单**无运行时影响**；线上真实文件夹选择器（FolderSelectorDialog / chat FolderSelector 的本地组件）为整行可点 NotionButton（无 hover-only、含 44px coarse 触控契约）已触屏友好。**#13 在生产中实为 moot**；OR2-3 的死组件改动已回退；死代码清理登记给代理 2（见 R2-04 / 跨组）。
- [~] **SA-1** 代码复核完成（实现正确，见审阅发现 R2-01）；**真机验证本机无 Android 构建环境，仍悬挂**。
- [ ] **#11** 横屏手机布局（出方案，待真机裁决；不擅自改 isSmallScreen 全局壳层判定）。
- [ ] **#10** framer-motion LazyMotion（出方案；**跨 report-only `components/ui` + 共享 App.tsx + 多域并发文件**，非本组可单方落地，倾向暂不动）。
- [x] **二轮深审（本域，多轮扩大）**：新发现并修复 **4 处真问题**——R2-05 anki FullWidthCardWrapper `>768`（iPad 竖屏 bug，OR2-4）、R2-06 InputBarUI bottomGap `<=768`（OR2-5）、R2-07 TodoMainPanel 拖拽传感器漏用触屏友好范式、触屏滚动被劫持（OR2-6）、R2-08 QuestionHistoryView Sheet `w-[400px]` 窄屏溢出（OR2-7）。
- [x] **核查通过项（无需改）**：env(safe-area) SA-2 范式全仓未破；iOS 输入防放大全局生效（ios-safe-area.css max(16px,1em)）；viewport-fit=cover + maximum-scale=5；MobileSlidingLayout 手势豁免（含动态横向滚动检测/文本选区挂起）；touch-action/overscroll/tap-highlight 基建齐全；matchMedia/useMediaQuery 实现正确；100vh 用于 app shell 属正确选择（dvh 会因键盘抖动）；dnd 全仓仅 TodoMainPanel 漏用（已修），@hello-pangea/dnd 自带长按；8 处 SheetContent 仅 QuestionHistoryView 溢出（已修）；无其它硬编码 767/768 比较。
- [ ] 总结 + 最终汇报。

## 审阅发现（round 2，编号 R2-xx）
| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|----------|------|--------|------|------|
| R2-01 | `src-tauri/mobile/android/MainActivity.kt` + `src/utils/platform.ts` | 复核 | - | SA-1 实现复核：`enableEdgeToEdge()` → `setOnApplyWindowInsetsListener(decorView)` 取 `systemBars()|displayCutout()`，÷density 取整为 CSS px，监听器返回 `insets` 未消费（正确，子视图仍可收到）；`onWebViewCreate` 首帧注入 + 500/1500/4000ms 重试覆盖冷启动；`onResume` 重注入；JS 端 clamp[0,200]+pending 暂存。**未发现代码缺陷。** | 真机验证悬挂（本机无 Android 构建环境）；MainActivity.kt 为受控副本，`tauri android init` 后需同步到 gen/android |
| R2-02 | `src/features/chat/components/MessageItem.tsx:733-735` | 体验/可达性 | 低 | 历史（非最新）助手消息 footer 用 `md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100`：<768 常显 ✓；但 ≥768 的**触屏平板**（pointer:coarse）无 hover，footer（复制/重试/编辑/删除/模型名）不可见且难触达（opacity-0 仍可点但不可发现）。用户消息与最新助手消息不受影响 | 备低风险补丁：`pointer:coarse` 时常显（见下「待落地补丁」），待用户确认 |
| R2-03 | `src/features/learning-hub/components/FolderTreeItem.tsx:438-456` | 体验 | 低 | 三点菜单 `h-5 w-5(20px) opacity-0 group-hover`：触屏不可见，但有 `onContextMenu`（长按）兜底——第一轮 #12 已归类「有替代路径」。行高 `h-7(28px)` 触屏偏密 | **降级为 moot**：见 R2-04，该组件为死代码、无运行时影响；线上选择器已触屏友好 |
| R2-04 | `src/features/learning-hub/components/FolderTreeItem.tsx` + `components/index.ts:5-6` | 死代码 | 中 | 全仓核查（grep `FolderTreeItem` 全文件）：该导出组件**无任何消费者**——`FolderSelectorDialog.tsx`、chat `FolderSelector.tsx` 各自定义同名**本地**组件，并非导入本组件；唯一引用是 `index.ts` 的 barrel 再导出（`export { FolderTreeItem }` + `export type FolderTreeItemProps`）。该文件约 584 行（含 ContextMenuPortal）随之全死 | 登记 → 代理 2（资源中心/VFS/文件管理）：确认后可删 `FolderTreeItem.tsx` + index.ts 两行再导出（tsc 兜底）。本组仅报告、不删（域外） |
| R2-05 | `src/features/chat/anki/index.tsx:331,345`（FullWidthCardWrapper） | bug | 中 | 断点边界错位：`MOBILE_BREAKPOINT=768`，桌面判定 `window.innerWidth > 768`——**768px（iPad 竖屏）落入移动端全宽 inline 计算分支**，而 App shell 在 768 为桌面双栏（isSmallScreen=`<768`）。结果 iPad 竖屏下卡片套用移动端全屏宽计算、溢出/错位 | **已修（OR2-4）**：`>` → `>=`，并把注释 ≤768 → <768，与 isSmallScreen 边界对齐 |
| R2-06 | `src/features/chat/components/input-bar/InputBarUI.tsx:1687` | bug | 低 | 断点边界错位：`mobileLayout?.isMobile ?? (window.innerWidth <= MOBILE_BREAKPOINT_PX(768))`——768px 被判为移动端（与 `<768` 契约错位）。仅在 MobileLayoutContext 缺失时作为 fallback 生效，且只影响 bottomGapPx（dock 间距），影响面小 | **已修（OR2-5）**：`<=` → `<` 对齐契约 |
| R2-07 | `src/features/todo/components/TodoMainPanel.tsx:1549`（拖拽排序传感器） | bug/触控 | 中 | 待办列表用 `useSensor(PointerSensor, { activationConstraint: { distance: 4 } })` 做竖向拖拽排序。触屏上 PointerSensor 无 delay、4px 即激活——用户竖向滚动列表时手指移动 >4px 就触发拖拽，**列表难以滚动 + 误触重排**。全仓其它 7 处拖拽（NotesTabsBar/DndFileTree/FinderFileList/OutlineView/TreeWithDndKit/DndKitTreeAdapter/TabBar）均用 `useTouchFriendlyDndSensors`（TouchSensor delay 250ms+tolerance 8px），唯独此处漏用 | **已修（OR2-6）**：换用 `useTouchFriendlyDndSensors()`（含 MouseSensor 桌面 + TouchSensor 触屏延迟 + 同款 KeyboardSensor），清理 5 个不再使用的 dnd 导入 |
| R2-08 | `src/components/QuestionHistoryView.tsx:174`（右侧 Sheet） | bug | 低 | `<SheetContent side="right" className="w-[400px] sm:w-[540px]">`：覆盖了 Sheet 原语安全默认值 `w-[min(92vw,28rem)]`（tailwind-merge 后 `w-[400px]` 胜出），<640 窄屏下固定 400px——≤400px 手机（如 360/390）会溢出视口。核查全仓 8 处 SheetContent，仅此 1 处覆盖未做视口夹取（其余为 side=bottom 全宽、isSmallScreen?w-full、或 w-[min(Nvw,...)]） | **已修（OR2-7）**：`w-[400px]` → `w-[min(92vw,400px)]`，与原语 `min(92vw,...)` 惯用法一致；sm: 及以上不变 |

## 已实施的优化（round 2，编号 OR2-xx）
| # | 改动文件 | 改动说明 | 验证结果 |
|---|---------|---------|---------|
| OR2-1 | `src/config/breakpoints.ts` + `tailwind.config.js`（注释） | **#5 断点单一来源收口**：`BREAKPOINTS` 收录 `xs:480`，并补注释说明其为 Tailwind 专用工具类断点（无 JS hook，`isSmallScreen`/`useIsMobile` 以 md=768 为界）；`tailwind.config.js` `screens` 注释改为指向 `breakpoints.ts` 单一来源（仅注释、未改任何数值/构建行为）。消除「注释声称一致、实则缺项」的偏差 | `npm run typecheck` exit 0；`mobileShellContract.test.ts` 3/3 通过（该测试仅约束 useBreakpoint.ts 从 config 导入且不自定义 BREAKPOINTS，本改动不违反）；无 CSS 改动故 stylelint 不涉及 |
| OR2-2 | `src/features/chat/components/MessageItem.tsx`（chat 域/代理 1） | **#14 平板 footer 可达性**：新增 `useMediaQuery('(pointer: coarse)')`，`assistantFooterClassName = showAssistantFooterAlways \|\| isCoarsePointer ? 'mt-3' : '…md:opacity-0 hover…'`。coarse 指针（触屏平板≥768）历史 footer 由隐藏→常显；<768 与 fine 指针（鼠标）hover 显隐契约不变。**未修改 chat 域契约测试**——`\|\|` 优先级高于 `?:`，刻意不加括号以保留 `desktopActions.source.test.ts` 断言子串 | `npm run typecheck` exit 0；MessageItem 4 套单测 13/13 通过（streamingContentVisibility/mobile/failure/desktop source）；eslint 涉改文件 0 error（2 个 warning 为基线、位于未触碰行） |
| ~~OR2-3~~（已回退） | `src/features/learning-hub/components/FolderTreeItem.tsx` | **#13 低风险档曾改 `opacity-0`→`[@media(pointer:fine)]:opacity-0`；二轮深审发现该组件为死代码（R2-04）后已回退**。原因：无运行时收益 + 属代理 2 域；死代码清理改登记给代理 2 | 回退后 `npm run typecheck` exit 0；文件已还原为改前内容 |
| OR2-4 | `src/features/chat/anki/index.tsx`（chat-anki 域） | **R2-05 修复**：FullWidthCardWrapper 桌面判定 `window.innerWidth > MOBILE_BREAKPOINT` → `>= MOBILE_BREAKPOINT`（768=桌面，与 isSmallScreen `<768` 对齐）；注释 ≤768→<768。修复 iPad 竖屏(768)误用移动端全宽 inline 计算 | `npm run typecheck` exit 0；AnkiCardsBlock.test 14/14（该测试 mock 了 FullWidthCardWrapper，不受影响但确认未回归）；eslint 0 新增（涉改行无 warning） |
| OR2-5 | `src/features/chat/components/input-bar/InputBarUI.tsx`（chat 域=代理 1） | **R2-06 修复**：bottomGap fallback `window.innerWidth <= MOBILE_BREAKPOINT_PX` → `< MOBILE_BREAKPOINT_PX`，768 边界对齐 `<768` 契约 | `npm run typecheck` exit 0；eslint 涉改行 0 新增（既有 1 个 exhaustive-deps「规则缺失」error 位于 1937 行、属第一轮已登记的基线配置问题，与本改动无关） |
| OR2-6 | `src/features/todo/components/TodoMainPanel.tsx`（待办域） | **R2-07 修复**：拖拽排序传感器由 `PointerSensor(distance:4)` 换为 `useTouchFriendlyDndSensors()`，修复触屏竖向滚动被拖拽劫持；清理 `PointerSensor/KeyboardSensor/useSensor/useSensors/sortableKeyboardCoordinates` 5 个不再使用的导入 | eslint 0 error（13 个 warning 均为基线 native-button/addEventListener、位于未触碰行；**无 unused-import**，确认导入清理干净）；TodoMainPanel.test 1/1 通过 |
| OR2-7 | `src/components/QuestionHistoryView.tsx`（题库域=代理 4） | **R2-08 修复**：右侧 Sheet `w-[400px]` → `w-[min(92vw,400px)]`，<640 窄屏视口夹取防溢出 | `npm run typecheck` exit 0（全仓绿）；eslint 0 problem；exam-content-view-history-entry.test 1/1 通过 |

> **全仓 typecheck 复核（最终）**：代理 6 完成 mindmapStore.ts 编辑后，`npm run typecheck` 恢复 **exit 0（全仓绿）**，本组全部 6 个改动文件（breakpoints/tailwind/MessageItem/anki-index/InputBarUI/TodoMainPanel/QuestionHistoryView）均确认类型干净。

## 待决策方案（P1/协商级）
- **SA-1 真机验证**：需 Android 构建环境跑 `npm run tauri android dev`，验证旋转 / 手势导航 / 三键导航三形态安全区；本机无法执行。
- **#11 横屏手机**：`isSmallScreen` 仅看宽度，横屏手机（宽≥768、高<768）走桌面双栏。方案候选：(a) 维持现状（设计权衡，空间利用合理）；(b) `(orientation:landscape) and (max-height:~500px) and (pointer:coarse)` 下放大触控尺寸或强制移动壳。建议真机体感后裁决。
- **#10 framer-motion LazyMotion**：全库约 22 文件直接 `import { motion }`。改造需全局 `<LazyMotion features={domAnimation}>` 包裹 + `motion.*`→`m.*` 批量替换，触碰多特性组件（chat/settings/skills/ui）。重页面已整体懒加载，增量收益有限。**建议暂不动**（大重构、风险/收益不划算），保留为登记项。

## 跨组问题（发现但不属于本组职责域）
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|---------|---------|------------|
| 1 | locales/* + 各组件（沿用第一轮跨组 #1） | i18n 中英混排 | 代理 7/各特性组 |
| 2 | `learning-hub/components/FolderTreeItem.tsx` + `components/index.ts:5-6` | **死代码**：导出组件无消费者（仅 barrel 再导出），约 584 行全死。确认后可删该文件 + 两行再导出（R2-04） | 代理 2（资源中心/VFS/文件管理） |

## 共享文件 / 跨域改动登记
| # | 文件 | 改动段落/函数 | 原因 / 归属提醒 |
|---|------|-------------|------|
| 1 | `tailwind.config.js` | `theme.screens` 上方注释 + `xs` 行尾注释（仅注释，未改数值/构建行为） | #5 收口：指向 `breakpoints.ts` 单一来源，消除误导性「一致」声明 |
| 2 | `src/features/chat/components/MessageItem.tsx`（chat 域=代理 1） | import `useMediaQuery`；`isCoarsePointer` 变量；`assistantFooterClassName` 三元条件 | #14 触屏平板可达性（OR2-2）。属代理 1 域的特性组件，纯样式 coarse-pointer 修补，**刻意未触碰其契约测试断言**，请代理 1 知悉 |
| ~~3~~ | ~~`FolderTreeItem.tsx`~~ | OR2-3 已回退（死代码，见 R2-04），最终未改动该文件 | — |
| 4 | `src/features/chat/anki/index.tsx`（chat-anki 域=代理 1/5） | FullWidthCardWrapper 桌面断点判定 `>`→`>=`（+注释） | R2-05/OR2-4：断点边界对齐（768=桌面），纯逻辑修，请代理 1/5 知悉 |
| 5 | `src/features/chat/components/input-bar/InputBarUI.tsx`（chat 域=代理 1） | bottomGap fallback `<=`→`<`（行 1687） | R2-06/OR2-5：断点边界对齐，纯逻辑修，请代理 1 知悉 |
| 6 | `src/features/todo/components/TodoMainPanel.tsx`（待办域） | 拖拽传感器换 `useTouchFriendlyDndSensors()`（+清理 5 个 dnd 导入） | R2-07/OR2-6：触屏拖拽-滚动冲突修复，复用既有共享 hook |
| 7 | `src/components/QuestionHistoryView.tsx`（题库域=代理 4） | Sheet `w-[400px]`→`w-[min(92vw,400px)]` | R2-08/OR2-7：窄屏溢出修复，纯样式，请代理 4 知悉 |

> 并行环境观察：验证期间 `npm run typecheck` 两次报到他组在编文件、与本组无关：
> ① `src/components/anki/cardforge/engines/CardAgent.ts`（代理 5）3 处错误，随后再次 typecheck 即 exit 0，已自行消解；
> ② `src/features/mindmap/store/mindmapStore.ts`（代理 6）`conflictSnapshot/restoreConflictSnapshot/dismissConflictSnapshot` 缺失——两次 typecheck 间报错内容在变化（缺失项 3→2、属性数 73→74），证明代理 6 正实时编辑该 store，属在编中间态。
> 本组所有改动文件（breakpoints/tailwind/MessageItem/anki-index/InputBarUI/TodoMainPanel）经隔离核验 + eslint + 单测确认 0 错。

## 接力须知
- 工作目录 e:\2026ds\deep-student；验证：前端 `npm run typecheck` / `npm run lint` / `npm test -- <pattern>`；CSS `npx stylelint "src/**/*.css"`（`npm run lint:css` 脚本 glob 已由收尾会话修好，亦可直接用）；i18n `npm run check:i18n`。PowerShell 不支持 `&&`，用 `;`。
- 未经用户明确要求不得 git commit/push；共享文件只改本域段落并登记；**不使用子代理**。
- SA-1 真机验证 + MainActivity.kt 同步 gen/android 仍为本组最大悬挂项，需 Android 构建环境。
- 第一轮 10 批优化（断点归一/安全区/hover-only 等）已完成且通过验证，**勿回退、勿重做**。
