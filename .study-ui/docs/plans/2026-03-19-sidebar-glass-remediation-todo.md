# Sidebar Glass Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让侧边栏毛玻璃恢复为清晰、稳定、可控的系统材质观感，同时消除 hover / 展开 / 切换时的发闪，并让设置项与启窗状态保持一致。

**Architecture:** 当前问题不是单点透明度，而是原生材质、Web 多层半透明底、交互态实色填充、以及双状态源共同叠加。修复应遵循“先统一材质职责，再收敛 token 和容器层，再处理交互与动画，最后校准设置与验证”的顺序，避免补丁式反复试色。

**Tech Stack:** React 19, Vite 7, TypeScript 5.9+, Tailwind CSS v4, Tauri 2.x, Radix UI, source/contract tests.

---

## 使用说明

- [ ] 按阶段顺序执行，不要跳步。
- [ ] 每完成一项就勾选对应方框。
- [ ] 每一阶段结束都先跑最小验证，再进入下一阶段。
- [ ] 不要在同一阶段同时改“原生材质职责”和“视觉 token”。

## 四轮调研结论摘要

- [ ] 轮 1 结论已确认：侧边栏当前是 `shell-backdrop -> shell-sidebar-backdrop -> shell-sidebar-surface` 三层主链路，标题区还有局部第 4 层，核心问题是多层 tint 叠加而不是单层玻璃。
- [ ] 轮 2 结论已确认：`hover/active` 仍是背景填充，且 translucent 分支大量使用 `transition-none`、`width`、`grid-template-rows`、`transform/opacity` 组合，直接放大发闪感。
- [ ] 轮 3 结论已确认：毛玻璃强度滑条只影响 `--app-sidebar-glass-alpha-shift -> --shell-sidebar-surface`，没有影响原生材质、外层 backdrop、主区表面，所以体感变化有限。
- [ ] 轮 4 结论已确认：修复顺序必须先做材质职责和状态源，再做 token / 容器 / 交互 / 动画，最后补验证矩阵。

## Phase 0 - 基线与边界锁定

**Files:**
- Modify: `src/components/shell/AppChrome.source.test.ts`
- Modify: `src/components/shell/Sidebar.source.test.ts`
- Modify: `src/styles/app.source.test.ts`
- Modify: `src/lib/native-window.test.ts`
- Modify: `src/lib/native-window-preference.test.ts`
- Modify: `scripts/window-background-system-effect-contract.test.mjs`
- Modify: `scripts/window-background-visual-contract.test.mjs`

- [x] 补 1 条 source/contract 测试，明确“侧边栏毛玻璃只允许 1 个主视觉承载层，其他层只能做布局或极轻底板”。
- [x] 补 1 条测试，锁定 macOS translucent 启窗与 JS 运行态不能出现状态源分叉。
- [x] 补 1 条测试，锁定毛玻璃强度滑条不得只改文案、不改实际消费变量。
- [x] 跑基线验证：

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/styles/app.source.test.ts src/lib/native-window.test.ts src/lib/native-window-preference.test.ts
node --test scripts/window-background-system-effect-contract.test.mjs scripts/window-background-visual-contract.test.mjs
```

## Phase 1 - 统一原生材质职责与状态源

**目标：** 先定义“谁负责毛玻璃”。系统材质负责 blur / material，Web 只做极轻 tint 与内容承载；并消除 Rust 启窗状态与 JS 运行时状态分叉。

**Files:**
- Modify: `src-tauri/src/window_background.rs`
- Modify: `src/lib/native-window.ts`
- Modify: `src/lib/native-window-preference.ts`
- Modify: `src/components/theme/theme-provider.tsx`
- Test: `src/lib/native-window.test.ts`
- Test: `src/lib/native-window-preference.test.ts`
- Test: `scripts/window-background-system-effect-contract.test.mjs`

- [ ] 明确 translucent 下 macOS / Windows 的唯一材质责任链，并写成测试约束。
- [ ] 统一 Rust 启窗偏好与前端运行时偏好，不再允许“Rust 读 JSON / 前端读 localStorage”长期分叉。
- [ ] 处理首次挂载不同步问题，避免“设置已开但启窗仍偏实”。
- [ ] 保持 reduced transparency 优先级最高，并确保 JS/Rust 同步回退逻辑一致。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/lib/native-window.test.ts src/lib/native-window-preference.test.ts src/lib/theme.test.ts
node --test scripts/window-background-system-effect-contract.test.mjs scripts/window-background-bootstrap-contract.test.mjs scripts/window-background-visual-contract.test.mjs
```

## Phase 2 - 收敛侧边栏 token，只保留一套有效玻璃表面

**目标：** 收敛 `--shell-backdrop`、`--shell-sidebar-backdrop`、`--shell-sidebar-surface` 的职责，避免 3 层都像主表面。

**Files:**
- Modify: `src/styles/app.css`
- Modify: `src/styles/app.source.test.ts`
- Modify: `src/lib/app-shell.ts`
- Test: `src/lib/app-shell.test.ts`

- [ ] 明确整窗 backdrop、侧边栏 backdrop、侧边栏 surface 的职责边界。
- [ ] 下调或合并重复的 sidebar 主表面 tint，避免双层甚至三层同时承载玻璃感。
- [ ] 保证主内容区 `--shell-panel` / `--shell-panel-strong` 不继续吃掉侧边栏的材质对比。
- [ ] 保留 reduced transparency 回退，但避免把 translucent 再混成接近 opaque。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/styles/app.source.test.ts src/lib/app-shell.test.ts
```

## Phase 3 - 清理容器层级与接缝

**目标：** 让 `AppChrome`、`Sidebar`、`Titlebar` 只保留一层真正负责玻璃感，其余层只做布局、拖动热区和分隔。

**Files:**
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/Titlebar.tsx`
- Modify: `src/components/shell/AppChrome.source.test.ts`
- Modify: `src/components/shell/Sidebar.source.test.ts`
- Modify: `src/components/shell/Titlebar.source.test.ts`
- Test: `scripts/floating-sidebar-contract.test.mjs`

- [ ] 清理 `AppChrome` 外层 sidebar backdrop 与 `Sidebar` 内层 surface 的重复承载关系。
- [ ] 收敛标题栏、侧边栏头部、左侧 seam 的层级，使它们属于同一套表面语义。
- [ ] 复查 drag region：保留热区，但不要再额外压出会钝化玻璃的无意义 tint。
- [ ] 去掉会制造“玻璃断层”的多余边线或表面差异。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts
node --test scripts/floating-sidebar-contract.test.mjs
```

## Phase 4 - 收敛交互态，去掉实色 hover / active 压层

**目标：** 让 hover / active / selected / icon ghost 不再用大面积实色背景压住玻璃。

**Files:**
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/ShellButton.tsx`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/components/shell/Sidebar.source.test.ts`
- Modify: `src/components/shell/ShellButton.source.test.ts`

- [ ] 把 sidebar 列表的 hover 从整行背景填充收敛为更轻的视觉反馈。
- [ ] 把 selected/current 从“整块灰底”收敛为更薄、更稳的选中表达。
- [ ] 清理顶部 icon/ghost 按钮在玻璃上打出的实色 hover slab。
- [ ] 保持移动端无 hover 依赖，键盘 focus 仍然清晰可见。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts src/components/shell/ShellButton.source.test.ts
```

## Phase 5 - 去掉 hover / 展开 / 切换发闪源

**目标：** 去掉或简化最容易引发材质重绘感的动画组合。

**Files:**
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/Titlebar.tsx`
- Modify: `src/components/shell/AppChrome.source.test.ts`
- Modify: `src/components/shell/Sidebar.source.test.ts`

- [ ] 去掉侧边栏外层 `width` 与内层 `transform/opacity` 的双重过渡叠加。
- [ ] 去掉标题栏附件区跟随侧边栏切换的多属性同步动画。
- [ ] 去掉 translucent 分支中会造成硬切的 `transition-none + hover:bg-*` 组合。
- [ ] 收敛文件夹展开动画，避免 `grid-template-rows`、`opacity`、箭头旋转叠加造成发闪。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts
```

## Phase 6 - 让“毛玻璃强度”设置真正有意义

**目标：** 让滑条的数值变化与用户体感变化一致，同时不破坏主区语义。

**Files:**
- Modify: `src/lib/app-settings.ts`
- Modify: `src/components/settings/AppSettingsProvider.tsx`
- Modify: `src/components/content/SettingsPanel.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/lib/app-settings.test.ts`
- Modify: `src/components/settings/AppSettingsProvider.source.test.ts`
- Modify: `src/components/content/SettingsPanel.source.test.ts`

- [ ] 明确滑条是否只调 sidebar surface，还是同时调 sidebar backdrop；不要继续出现“拖动很大但几乎没变化”。
- [ ] 保证文案和实现语义一致，避免“数值更高更明显”与底层实际方向相反。
- [ ] 毛玻璃关闭时，滑条必须正确禁用；毛玻璃开启时，刷新后必须保留值。
- [ ] 不允许滑条影响主工作区表面语义。
- [ ] 跑阶段验证：

```bash
node --test --experimental-strip-types src/lib/app-settings.test.ts src/components/settings/AppSettingsProvider.source.test.ts src/components/content/SettingsPanel.source.test.ts
```

## Phase 7 - 完整回归与人工验收

**自动验证**

- [ ] 跑壳层源码契约：

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts src/components/shell/ShellButton.source.test.ts src/components/shell/SidebarUpdateBadge.source.test.ts
```

- [ ] 跑运行时逻辑：

```bash
node --test --experimental-strip-types src/lib/app-shell.test.ts src/lib/theme.test.ts src/lib/native-window.test.ts src/lib/native-window-preference.test.ts src/lib/app-settings.test.ts
```

- [ ] 跑样式与原生合同：

```bash
node --test src/styles/app.source.test.ts scripts/window-background-bootstrap-contract.test.mjs scripts/window-background-system-effect-contract.test.mjs scripts/window-background-visual-contract.test.mjs scripts/floating-sidebar-contract.test.mjs
```

- [ ] 跑仓库级检查：

```bash
npm run lint
npm run build
```

**人工验收**

- [ ] macOS：浅色 / 深色下，`translucent/opaque` 切换后，标题栏、侧边栏、主内容区层级一致，无边缝、无发灰、无首帧错误状态。
- [ ] Windows：确认 `Mica -> Blur` 回退链不导致 sidebar 比主区更实，且切换时无突兀色差。
- [ ] 侧边栏 hover：鼠标快速扫过主入口、文件夹、子会话、设置项，不再出现硬切闪烁。
- [ ] 侧边栏切换：展开/收起、设置页强制展开、紧凑视口 Sheet 开关，均无闪烁、无点击残留。
- [ ] 文件夹展开：展开/折叠时没有明显材质跳闪，箭头、内容区和右侧操作显隐节奏一致。
- [ ] 设置项：毛玻璃开关、强度滑条、顶部 inset、字体与缩放，修改后即时生效、刷新保留、禁用态正确。
- [ ] 系统减少透明度：开启后必须正确回退到更实的外观，关闭后能恢复 translucent，不允许 Web/UI 与原生窗口壳不一致。

## 完成定义

- [ ] 侧边栏毛玻璃由“半透明实色叠层”收敛为“明确的系统材质 + 克制的 Web 表面”。
- [ ] hover / active / selected 不再用大面积实色压住毛玻璃。
- [ ] hover 闪、展开闪、切换闪都被收敛到不可感知或极轻微。
- [ ] 毛玻璃强度滑条对用户体感真实有效。
- [ ] 启窗状态、运行时状态、设置状态三者一致。
- [ ] 自动测试与人工验收全部通过。
