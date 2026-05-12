# 2026-03-17 macOS 红绿灯与侧边栏同线修复（四轮并行调研版 TODO）

## 目标
- 红绿灯不再出现“在窗口外”的感知。
- 红绿灯、侧边栏切换 icon、更新 Badge 在同一视觉线。
- 修复后有可执行验证与防回归断言。

## 四轮并行调研结论（落地版）

### Round 1：前端壳层与样式
- 发现标题栏侧边栏切换按钮位置由 `leadingAccessoryOffset` 控制，但存在硬编码偏移与几何 token 脱节。
- 发现侧边栏头部与标题栏不是同一套几何来源，导致同线关系不稳定。

### Round 2：Tauri 原生窗口与合约
- `decorations: true + titleBarStyle: Transparent + hiddenTitle: true + transparent: true` 被证实会让原生 titlebar 与 Web 内容分层，红绿灯会被读成“悬在窗口外”。
- 最终收口改为 `decorations: true + titleBarStyle: Overlay + hiddenTitle: true + transparent: false`，并把毛玻璃效果留给运行时 `WindowBackground`。
- `trafficLightPosition` 被刻意禁用，说明红绿灯位置以系统原生为准，前端必须避让而非“摆放红绿灯”。

### Round 3：历史方案与测试覆盖
- 历史文档已识别问题，但未形成“几何统一 + 测试闭环”的一次性收口。
- 现有测试更偏配置存在性校验，缺少“同线结果”与“native-transparent 左侧避让”断言。

### Round 4：最小改动策略与风险
- 最小高收益修复集中在 `src/lib/app-shell.ts` 与 `src/components/shell/SidebarUpdateBadge.tsx`。
- 若仅改两处即可显著改善：统一 left inset 逻辑 + 统一控制高度节奏。

## 根因判定（按优先级）
- P0：原生窗口使用 `Transparent + transparent: true` 时，titlebar 与 Web 内容不在同一个 fullsize content view，导致红绿灯出现“在窗口外”的视觉感知。
- P0：`native-transparent` 下左侧避让不足，导致红绿灯区域被前端内容侵入。
- P0：标题栏/侧边栏控件垂直节奏不统一，导致“看起来不在一条线”。
- P1：Badge 高度与标题栏控件高度体系不一致，放大了错线感。
- P1：测试缺同线断言，修了也容易回归。

## 可执行 TODO（给 LLM 打勾）

### A. 几何统一（P0，必须先做）
- [x] 统一 `native-transparent` 与 `native-overlay` 的左侧避让策略：红绿灯 trailing edge + gap 作为起始基准。
- [x] 在 `src/lib/app-shell.ts` 收敛 `getOverlayLeadingInset`，确保 macOS 两种模式都不侵入红绿灯区域。
- [x] 在 `src/lib/app-shell.ts` 校准 `getSidebarHeaderHeight` 与标题栏控制高度关系，保证视觉中线一致。

### B. 视觉节奏统一（P0）
- [x] 将侧边栏更新 Badge 高度与标题栏控制尺寸统一到同一体系（优先 32 高度节奏）。
- [x] 复核侧边栏头部图标按钮与 Badge 的垂直对齐，不新增动画，不改主题 token。

### C. 测试闭环（P0）
- [x] 在 `src/lib/app-shell.test.ts` 新增：`native-transparent` 左侧避让不小于红绿灯 trailing edge + gap。
- [x] 在 `src/lib/app-shell.test.ts` 新增：macOS 模式下红绿灯中心线与切换按钮中心线公式一致。
- [x] 在 `scripts/macos-titlebar-geometry-contract.test.ts` 或对应契约测试补“同线防回归”断言。

### D. 验收与回归（P1）
- [x] 运行 `npm run lint`。
- [x] 运行核心测试：`node --test --experimental-strip-types src/lib/app-shell.test.ts scripts/macos-titlebar-geometry-contract.test.ts`。
- [x] 运行 `npm run tauri:dev`，在 macOS 下肉眼检查三点同线（红绿灯、切换 icon、Badge）。
  - 结果（2026-03-17）：已启动 `target/debug/app`，并在图形桌面会话完成截图验收；红绿灯已回到窗口内，切换 icon 与 Badge 固定在同一条 macOS 顶部 chrome 线上。原生收口采用 `titleBarStyle = Overlay` + `transparent = false`，运行时继续使用 `WindowBackground` 且跟随窗口激活状态。
- [x] 在本文件补充最终采用值（left inset、header height、badge height）并勾选归档。
  - 最终采用值：`left inset = 76px`、`header height = 42px`、`badge height = 32px`

## 验收标准（DoD）
- [x] 红绿灯不再出现“在窗口外”的视觉感知。
- [x] 红绿灯、侧边栏切换 icon、更新 Badge 同线（允许 ±1px 视觉误差）。
- [x] 新增测试通过且能阻止同类回归。
- [x] 不破坏 Windows 与移动端既有行为。

## 引用链接（仅引用，不贴全文）
- 原生几何定义：[src/lib/macos-titlebar-geometry.ts](../../src/lib/macos-titlebar-geometry.ts)
- 壳层布局公式：[src/lib/app-shell.ts](../../src/lib/app-shell.ts)
- 壳层单测：[src/lib/app-shell.test.ts](../../src/lib/app-shell.test.ts)
- 标题栏组件：[src/components/shell/Titlebar.tsx](../../src/components/shell/Titlebar.tsx)
- 侧边栏组件：[src/components/shell/Sidebar.tsx](../../src/components/shell/Sidebar.tsx)
- 更新徽标组件：[src/components/shell/SidebarUpdateBadge.tsx](../../src/components/shell/SidebarUpdateBadge.tsx)
- macOS 合约测试：[scripts/macos-titlebar-geometry-contract.test.ts](../../scripts/macos-titlebar-geometry-contract.test.ts)
- 浮动侧边栏合约：[scripts/floating-sidebar-contract.test.mjs](../../scripts/floating-sidebar-contract.test.mjs)
- 原生窗口背景运行时逻辑：[src-tauri/src/window_background.rs](../../src-tauri/src/window_background.rs)
- macOS Tauri 配置：[src-tauri/tauri.macos.conf.json](../../src-tauri/tauri.macos.conf.json)
- 历史对齐计划：[docs/plans/2026-03-13-apple-ui-ux-alignment-executable-todo.md](2026-03-13-apple-ui-ux-alignment-executable-todo.md)
- 历史同类方案：[docs/plans/2026-03-16-sidebar-right-edge-occlusion-executable-todo.md](2026-03-16-sidebar-right-edge-occlusion-executable-todo.md)

## 给 LLM 可直接复制的执行 Prompt

请严格按此 TODO 执行，不要新增功能，不要改视觉风格：

1) 先改几何统一：
- 在 src/lib/app-shell.ts 修复 macOS native-transparent 的 left inset，保证不侵入红绿灯区域；
- 同步校准 getSidebarHeaderHeight 与标题栏控件高度关系，让红绿灯、侧边栏切换 icon、更新 Badge 在同一视觉线。

2) 再改视觉节奏：
- 在 src/components/shell/SidebarUpdateBadge.tsx 将 Badge 高度改到与标题栏控件同一节奏（优先 32）。

3) 再补测试：
- 在 src/lib/app-shell.test.ts 增加 native-transparent 左侧避让断言；
- 增加红绿灯中心线与切换按钮中心线一致断言；
- 在 scripts/macos-titlebar-geometry-contract.test.ts 或同层契约测试补同线防回归断言。

4) 最后验证：
- 跑 npm run lint；
- 跑 node --test --experimental-strip-types src/lib/app-shell.test.ts scripts/macos-titlebar-geometry-contract.test.ts；
- 跑 npm run tauri:dev，肉眼确认红绿灯、切换 icon、Badge 同线；
- 回填本文件 TODO 勾选状态与最终采用值（left inset/header height/badge height）。

输出格式要求：
- 只汇报变更文件、关键差异、测试结果、是否通过 DoD；
- 不输出无关重构；
- 不引入新依赖。
