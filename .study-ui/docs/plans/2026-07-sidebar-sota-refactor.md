# Sidebar 组件 SOTA 优化方案

> **来源**：基于 4 轮并行审计（Demo 数据、CSS tokens、AppChrome 布局、Theme/Settings 系统）+ frontend-design SKILL + ui-skills SKILL 约束。
> **目标**：将当前侧边栏提升至 Codex/ChatGPT 级别的设计水准。

---

## 引用文件

| 文件 | 作用 |
|------|------|
| [src/components/shell/ShellButton.tsx](../../src/components/shell/ShellButton.tsx) | 按钮原语，nav 变体 |
| [src/components/shell/Sidebar.tsx](../../src/components/shell/Sidebar.tsx) | 侧边栏主组件 |
| [src/components/shell/AppChrome.tsx](../../src/components/shell/AppChrome.tsx) | 桌面壳层包裹层 |
| [src/components/shell/sidebar-settings.ts](../../src/components/shell/sidebar-settings.ts) | 设置导航常量 |
| [src/styles/app.css](../../src/styles/app.css) | CSS tokens 定义 |
| [src/lib/app-shell.ts](../../src/lib/app-shell.ts) | 布局计算逻辑 |
| [src/App.tsx](../../src/App.tsx) | Demo 数据与入口 |
| [src/lib/demo-fixtures.tsx](../../src/lib/demo-fixtures.tsx) | Demo 预览数据 |
| [src/components/theme/theme-provider.tsx](../../src/components/theme/theme-provider.tsx) | 主题管理 |
| [src/lib/native-window.ts](../../src/lib/native-window.ts) | 原生窗口效果 |

---

## P0 — 视觉正确性（必须修）

- [x] **修复 interactive-selected/hover 深度倒置**
  - light: hover=#ECECE7, selected=#E2E2DD; dark: hover=#2E2E2C, selected=#353533
  - 选中态现在比 hover 更深，视觉权重正确

- [x] **修复暗色模式 sidebar-muted 与 sidebar-foreground 相同**
  - 改为 `rgba(255, 255, 255, 0.5)`，与 foreground 区分

- [x] **移除 settings-nav-item-label 硬编码 `#000000`**
  - 浅色/暗色统一使用 `var(--color-sidebar-foreground)`

---

## P1 — 交互规范

- [x] **选中项彻底禁用交互反馈**
  - `cursor-default`、无 hover 类、onClick=undefined 已一致应用

- [x] **ShellButton nav 变体：保留 transition-colors（合理）**
  - 侧边栏属于 small/local UI，paint 属性过渡可接受

- [x] **为 nav 列表添加 ARIA 语义**
  - 添加 `nav[aria-label]`、`role="list"`、`role="listitem"`、`aria-current="page"`

---

## P2 — 布局与动画

- [x] **评估侧边栏宽度动画合规性**
  - width 过渡而非 transform 是为了让 main content 自然回流
  - 220ms ease-in-out，≤ 300ms 要求合规

- [x] **合并 3 个重复的 sidebar toggle 按钮**
  - 移除死代码 `titlebarLeadingAccessory`（条件永假），共享 `toggleLabel` 变量

- [x] **prefersReducedMotion 需要动态监听**
  - 改用 `useSyncExternalStore` 订阅 MediaQuery 变化

- [x] **移除 loading skeleton 无限动画**
  - 添加 `motion-reduce:animate-none` 降级

---

## P3 — 数据与类型

- [x] **统一 Demo 数据源**
  - 新建 `src/lib/sidebar-data.tsx` 共享类型与数据
  - App.tsx 和 demo-fixtures.tsx 均从此模块导入

- [x] **消除 unsafe `as` 类型断言**
  - 用 `.find()` 类型窄化替代 `as SettingsTabId`

- [x] **设置导航图标尺寸统一**
  - 导航项 `size={16}`、动作按钮 `size={18}` 已一致

---

## P4 — 健壮性

- [x] **原生窗口操作添加错误处理**
  - 添加 `.catch()` + `console.warn` 日志

- [x] **后端同步调用保护**
  - 添加 `try/catch` + `console.warn`，失败时返回 `"skipped"`

- [x] **主题 Effect 依赖项精简**
  - 移除冗余 `resolvedTheme` 依赖，在 Effect 内部局部计算

---

## 合规性检查清单

| 约束来源 | 规则 | 当前状态 |
|----------|------|----------|
| AGENTS.md | 禁止 `text-3xl` 及更大字号 | ✅ 合规 |
| AGENTS.md | 禁止 `shadow-2xl` | ✅ 合规 |
| AGENTS.md | 禁止无限循环动画（loading spinner 除外） | ❌ `animate-pulse` |
| AGENTS.md | 所有过渡 ≤ 300ms | ✅ 220ms |
| AGENTS.md | 禁止 transform 缩放 | ✅ 合规 |
| AGENTS.md | 尊重 reduced-motion | ⚠️ 静态读取 |
| ui-skills | 不动画 layout 属性 | ❌ width 动画 |
| ui-skills | 使用 `h-dvh` 不用 `h-screen` | ✅ h-dvh |
| ui-skills | icon-only 按钮须 `aria-label` | ✅ 合规 |
| ui-skills | 不手动重建 focus 行为 | ✅ 合规 |
| frontend-design | 避免通用 AI 审美 | ✅ 自定义 token |
