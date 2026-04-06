# macOS Native Unified Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 macOS 下的窗口只保留一层原生材质，Sidebar 退回透明导航层，内容区与导航区形成连续平面，不再伪造 Liquid Glass 或旧式内嵌圆角面板。

**Architecture:** 原生窗口负责全部系统材质，Web 只负责布局、间距、选中态与分隔。macOS `native-transparent` 分支下移除 sidebar / titlebar / main workspace 的独立表面语义，只保留一层连续平面和一条克制的 seam。Windows 与其他平台保留现有保守分区，但不继续扩大大轮廓圆角的存在感。

**Tech Stack:** React 19, TypeScript 5.9+, Tailwind CSS v4, Tauri 2.x, source tests, contract tests.

---

### Task 1: 锁定 macOS 只允许单一原生材质

**Files:**
- Modify: `src/lib/native-window.ts`
- Modify: `src-tauri/src/window_background.rs`
- Modify: `scripts/window-background-system-effect-contract.test.mjs`
- Modify: `scripts/window-background-bootstrap-contract.test.mjs`

**Step 1: 写失败约束**

- 增加契约测试，明确 macOS translucent 只能使用 `WindowBackground`。
- 增加契约测试，明确不允许 runtime 或 bootstrap 切换到 `Sidebar` / `ContentBackground`。
- 增加契约测试，明确 `radius` 仍为 `None`，不允许通过原生圆角参数伪造 Tahoe 轮廓。

**Step 2: 跑测试确认失败**

Run:

```bash
node --test scripts/window-background-system-effect-contract.test.mjs scripts/window-background-bootstrap-contract.test.mjs
```

**Step 3: 收敛实现**

- 保持 `src/lib/native-window.ts` 的 macOS translucent 分支只返回 `macos-window-background`。
- 保持 `src-tauri/src/window_background.rs` 只设置 `WindowEffect::WindowBackground`。
- 不新增任何 `radius`、`Sidebar`、`ContentBackground` 分支。

**Step 4: 再跑测试**

Run:

```bash
node --test scripts/window-background-system-effect-contract.test.mjs scripts/window-background-bootstrap-contract.test.mjs
```

**Step 5: Commit**

```bash
git add src/lib/native-window.ts src-tauri/src/window_background.rs scripts/window-background-system-effect-contract.test.mjs scripts/window-background-bootstrap-contract.test.mjs
git commit -m "refactor(shell): keep macos material native and singular"
```

### Task 2: 让 macOS Sidebar 退回透明导航层

**Files:**
- Modify: `src/lib/app-shell.ts`
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/Titlebar.tsx`
- Modify: `src/components/shell/Sidebar.source.test.ts`
- Modify: `src/components/shell/Titlebar.source.test.ts`

**Step 1: 写失败约束**

- 增加 source test，明确 macOS `native-transparent` 下 `Sidebar` 外层和 header 不再使用 sidebar surface 背景。
- 增加 source test，明确 `getNavigationSurfaceClass()` / `getSidebarSurfaceClass()` 在 macOS translucent 分支可返回透明语义。
- 增加 source test，明确 `Titlebar` 在该分支不再额外承载独立 panel 观感。

**Step 2: 跑测试确认失败**

Run:

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts
```

**Step 3: 写最小实现**

- 在 `src/lib/app-shell.ts` 中新增更明确的 macOS translucent 判断，给 sidebar / titlebar 返回 `bg-transparent`。
- 在 `src/components/shell/Sidebar.tsx` 中移除外层 `aside` 与 header 对 macOS translucent 的独立表面依赖。
- 在 `src/components/shell/Titlebar.tsx` 中保留布局和 drag region，但不再给它一层模拟玻璃的 DOM 表面。

**Step 4: 再跑测试**

Run:

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/app-shell.ts src/components/shell/Sidebar.tsx src/components/shell/Titlebar.tsx src/components/shell/Sidebar.source.test.ts src/components/shell/Titlebar.source.test.ts
git commit -m "refactor(shell): make macos sidebar a transparent nav layer"
```

### Task 3: 把内容区和导航区改成连续平面

**Files:**
- Modify: `src/components/shell/AppChrome.tsx`
- Modify: `src/components/shell/AppChrome.source.test.ts`
- Modify: `src/styles/app.css`

**Step 1: 写失败约束**

- 增加 source test，明确 docked sidebar 展开时主内容区不能再有 `rounded-tl-*`、`rounded-bl-*` 这种大轮廓圆角。
- 增加 source test，明确 sidebar 与 main 之间只保留 seam，不再依赖双 panel 色块对撞制造层级。

**Step 2: 跑测试确认失败**

Run:

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts
```

**Step 3: 写最小实现**

- 删除 `src/components/shell/AppChrome.tsx` 中 `ml-px rounded-tl-[var(--radius-section)] rounded-bl-[var(--radius-section)]`。
- 让 sidebar 容器和主内容区共享同一连续背景语义。
- 保留一条轻量 seam；如果 seam 仍显得多余，再将其进一步减弱。
- 不再通过不同大底色块去伪造“左边玻璃、右边内容卡片”的分层。

**Step 4: 再跑测试**

Run:

```bash
node --test --experimental-strip-types src/components/shell/AppChrome.source.test.ts
```

**Step 5: Commit**

```bash
git add src/components/shell/AppChrome.tsx src/components/shell/AppChrome.source.test.ts src/styles/app.css
git commit -m "refactor(shell): unify sidebar and workspace into one plane"
```

### Task 4: 收敛交互态，避免把透明导航层重新涂实

**Files:**
- Modify: `src/components/shell/Sidebar.tsx`
- Modify: `src/components/shell/ShellButton.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/components/shell/Sidebar.source.test.ts`

**Step 1: 写失败约束**

- 增加 source test，明确 macOS translucent 下 sidebar hover / selected 不能再使用大面积实底。
- 增加 source test，明确导航项反馈以轻度 tint、文字权重或边界强调为主，而非整块 slab。

**Step 2: 跑测试确认失败**

Run:

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts
```

**Step 3: 写最小实现**

- 收敛 `bg-interactive-hover` / `bg-interactive-selected` 的面积和强度。
- 优先用更轻的背景、文字对比、左侧微弱边界或更稳的内边距节奏表达当前项。
- 保持 focus ring 清晰，但不要把透明层重新刷成一整块灰板。

**Step 4: 再跑测试**

Run:

```bash
node --test --experimental-strip-types src/components/shell/Sidebar.source.test.ts
```

**Step 5: Commit**

```bash
git add src/components/shell/Sidebar.tsx src/components/shell/ShellButton.tsx src/styles/app.css src/components/shell/Sidebar.source.test.ts
git commit -m "refactor(shell): lighten macos sidebar interaction states"
```

### Task 5: 做回归验证，确保只有 macOS 视觉语义改变

**Files:**
- Modify: `scripts/floating-sidebar-contract.test.mjs`
- Modify: `scripts/window-background-visual-contract.test.mjs`
- Modify: `src/styles/app.source.test.ts`

**Step 1: 写回归约束**

- 明确 macOS translucent 是“单一原生材质 + 透明 sidebar + 连续平面”。
- 明确 Windows translucent 仍允许保守分区，不强行套用 macOS 透明导航层。
- 明确 opaque 模式不被误伤。

**Step 2: 跑验证**

Run:

```bash
node --test --experimental-strip-types src/styles/app.source.test.ts
node --test scripts/floating-sidebar-contract.test.mjs scripts/window-background-visual-contract.test.mjs
npm run lint
npm run build
```

**Step 3: 人工验收**

- macOS translucent：侧边栏不再像一块独立玻璃板。
- macOS translucent：主内容区不再像嵌入窗口的圆角卡片。
- macOS translucent：traffic lights 仍保持原生行为，不被 DOM 遮挡。
- Windows / opaque：界面结构不崩，分区仍清晰。

**Step 4: Commit**

```bash
git add scripts/floating-sidebar-contract.test.mjs scripts/window-background-visual-contract.test.mjs src/styles/app.source.test.ts
git commit -m "test(shell): lock native macos unified plane behavior"
```

## 完成定义

- macOS translucent 下只有一层原生材质承担玻璃感。
- Sidebar 在 DOM 中退回透明导航层，而不是伪玻璃 panel。
- Sidebar 与主内容区形成连续平面，不再出现旧式大轮廓圆角嵌套。
- 交互态不会把透明导航层重新刷成实心板。
- Windows 与 opaque 模式保持保守、稳定、不被误伤。
