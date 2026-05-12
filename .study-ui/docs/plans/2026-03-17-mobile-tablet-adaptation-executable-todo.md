# 平板与移动端适配执行清单

> **For Claude / Codex / other LLM:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this todo one checkbox at a time. Mark a box only after file evidence and verification.
>
> **Context:** 这次不是重写产品，也不是重做设计系统，而是在当前 Claude Code 已写出的桌面优先代码上，补齐 phone / tablet / desktop 三档适配能力，并保持方案简单、可维护、可持续扩展。

**Goal:** 让当前 Tauri + React UI 在手机、平板、桌面三档下都可用，且后续新增页面时只需要复用同一套断点与 token，不再到处补 class 和 `matchMedia`。

**Architecture:** 行为层只分两套：`compact(<1024)` 与 `desktop(>=1024)`；视觉密度分三档：`phone(<640)`、`tablet(640-1023)`、`desktop(>=1024)`。所有断点判断收敛到一个 JS 来源，所有布局尺寸优先收敛到 `src/styles/app.css` token，尽量不改现有信息架构与壳层骨架。

**Tech Stack:** React 19, Vite 7, TypeScript 5.9+, Tailwind CSS v4, Radix UI, shadcn/ui, Phosphor Icons, Tauri 2

---

## Markdown 引用链接

> [当前执行清单](./2026-03-17-mobile-tablet-adaptation-executable-todo.md)
>
> [Codex 布局对齐执行清单](./2026-03-16-codex-app-layout-alignment-executable-todo.md)
>
> [统一 Demo 收敛方案](./2026-03-16-unified-ui-ux-demo-reduction-todo.md)

---

## 四轮并行调研摘要

### Round 1 - 壳层与侧边栏

- `src/components/shell/AppChrome.tsx` 当前只区分 `<768` 和 `>=768`，没有独立的平板层，导致手机和平板混在一起，或平板直接继承桌面壳层。
- `src/App.tsx` 里的 `isSidebarOpen` 同时承担抽屉开关、桌面侧栏开关、设置页强制展开，状态语义过载。
- 当前推荐做法不是三套壳层并行，而是保留现有 `App -> AppChrome -> Sidebar + Main` 骨架，只把 sidebar 呈现方式收敛成 phone / tablet / desktop 三态。

### Round 2 - 对话主工作区与输入区

- `src/components/content/ThreadCanvas.tsx` 的空态和输入区仍偏桌面，宽度、间距、底部安全区、触控尺寸有多处硬编码。
- `src/components/ui/button.tsx` 的 `sm` 和 `icon` 尺寸在移动端不够稳，`src/components/ui/textarea.tsx` 14px 输入字号也不利于移动 WebView。
- 最简方案是让 `ThreadCanvas` 只消费 token，不自己定义大量宽度和 padding。

### Round 3 - 设置页

- `src/components/content/SettingsPanel.tsx` 已经是超长单页；手机端最缺的是“页内定位”和“高密度区块降级”，而不是新做一套设置页。
- `Tabs`、`Switch`、多列伪表格、快捷键双列卡片都需要在小屏下收敛到单列或可横滑形态。
- 最小改法是把响应式差异收敛在 `SettingsSection` / `SettingBlock` / `SettingsRow`，而不是把判断散落到每个设置块。

### Round 4 - 工程实施与验证

- 当前最大维护风险是断点来源分裂：JS 里有 `matchMedia`，组件里散落 `sm:` / `md:` / `lg:`，CSS token 又是另一套。
- 最稳妥的路线是：一个统一 viewport 模型 + 少量布局 token + 先壳层/再内容区/最后验收。
- 不要把这次适配演变成三套组件，也不要新增第二套设计系统。

---

## 最终推荐策略

- **行为层：** 只分 `compact` 与 `desktop`，避免三套交互并行。
- **密度层：** 分 `phone` / `tablet` / `desktop` 三档，用 token 控制边距、宽度、控件高度。
- **状态层：** 把 sidebar 开关拆分成“手机抽屉开关”和“桌面/平板折叠状态”。
- **组件层：** 尽量复用现有 `Sidebar`、`ThreadCanvas`、`SettingsPanel`，不要拆出三套页面。
- **测试层：** 先锁断点逻辑和布局语义，再做手工视口验收。

---

## Executable Checklist

### Phase 0 - 先锁边界

- [ ] 这次任务明确是“优化 Claude Code 已写出的现有代码”，不是重写产品。
- [ ] 不新增组件库，不新增 CSS-in-JS，不新增第二套设计系统。
- [ ] 保留现有 `App -> AppChrome -> Sidebar + Main` 骨架，不拆成三套 app shell。
- [ ] 保留当前主题、半透明、Tauri titlebar 与窗口行为逻辑，响应式只做必要收敛。

### Phase 1 - 收敛断点模型

**涉及文件**

- `src/lib/app-shell.ts`
- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- 新增：`src/lib/responsive.ts` 或 `src/components/shell/useShellViewport.ts`
- 新增：`src/lib/responsive.test.ts`

- [ ] 新增统一响应式模型，至少导出：
  - `phone < 640`
  - `tablet 640-1023`
  - `desktop >= 1024`
  - `isCompact = width < 1024`
- [ ] 移除 `src/components/shell/AppChrome.tsx` 内部零散 `matchMedia("(max-width: 767px)")` 判断。
- [ ] 让 JS 层只保留一份断点来源，禁止页面组件自己再写新的 `matchMedia`。
- [ ] 为断点模型补单测，覆盖边界宽度：`639 / 640 / 767 / 768 / 1023 / 1024`。

### Phase 2 - 收敛布局 token

**涉及文件**

- `src/styles/app.css`
- `src/components/ui/button.tsx`
- `src/components/ui/textarea.tsx`
- `src/components/ui/input.tsx`

- [ ] 在 `src/styles/app.css` 新增或补齐以下 token：
  - `--layout-page-x`
  - `--layout-page-y`
  - `--layout-content-max`
  - `--layout-settings-max`
  - `--layout-sidebar-sheet-width`
  - `--layout-sidebar-tablet-width`
  - `--layout-composer-max`
  - `--layout-touch-target`
  - `--thread-inline-padding`
  - `--thread-block-padding`
  - `--composer-padding-inline`
  - `--composer-padding-bottom`
- [ ] 用默认 / `sm-md` / `lg+` 三档覆写这些 token，而不是在每个页面重复写一组 class。
- [ ] 优先复用现有 `--workspace-max-width`、`--composer-max-width`、`--control-height-touch`、`--safe-area-*`，不要再造重复 token。
- [ ] `Button` 的 `sm` 和 `icon` 尺寸在移动端回到 44px 触控下限，桌面端再回到紧凑高度。
- [ ] `Textarea` 基础字号改为移动端 `text-base`，桌面端再收回 `text-sm`，避免小屏输入放大。

### Phase 3 - 改造 shell 响应式骨架

**涉及文件**

- `src/App.tsx`
- `src/components/shell/AppChrome.tsx`
- `src/components/shell/Sidebar.tsx`
- 可选新增：`src/components/shell/ResponsiveSidebar.tsx`

- [ ] 把 `src/App.tsx` 的 sidebar 状态拆成：
  - `mobileSidebarOpen`
  - `sidebarCollapsed`
- [ ] `phone` 使用 `Sheet` 侧栏。
- [ ] `tablet` 使用内联可折叠侧栏，默认宽度控制在约 `240px`，不要直接沿用桌面 `272px`。
- [ ] `desktop` 保持当前 docked sidebar 方案。
- [ ] 侧栏内容继续复用同一个 `Sidebar`，只切换外层呈现方式。
- [ ] `compact` 下点选导航后自动关闭侧栏，避免用户多一步手动收起。
- [ ] 小屏时精简标题栏动作，只保留菜单、返回、核心操作；桌面型状态信息不要直接塞进手机头部。
- [ ] 触摸布局下弱化桌面 drag hotspot / titlebar inset 逻辑，避免手机 WebView 被桌面壳层规则拖累。

### Phase 4 - 改造聊天主内容区

**涉及文件**

- `src/components/content/ThreadCanvas.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/textarea.tsx`
- `src/styles/app.css`

- [ ] `ThreadCanvas` 不再写死 `44rem`、`32rem`、`px-4 md:px-8` 这类宽度和边距，统一改为消费 token。
- [ ] composer 底栏补上 `safe-area-bottom`、`safe-area-left`、`safe-area-right`。
- [ ] 手机端默认让空态上移，输入区更靠前；不要继续使用强桌面化的垂直居中首屏。
- [ ] 手机端次级操作改成更稳的两行或横滑布局；`sm` 以上再回到单行。
- [ ] 发送按钮、附件按钮、模型按钮都满足移动端最小触控面积。
- [ ] 小屏或 `pointer: coarse` 下退回系统原生滚动条，不强依赖桌面定制滚动条。

### Phase 5 - 改造设置页

**涉及文件**

- `src/components/content/SettingsPanel.tsx`
- `src/components/content/SettingsDemoPanel.tsx`
- `src/components/ui/tabs.tsx`
- `src/components/ui/switch.tsx`
- `src/lib/settings-panel.ts`

- [ ] 保留当前单列正文壳层，不做独立 mobile settings 页面。
- [ ] 手机端默认单列堆叠，`md` 恢复少量双列，`lg` 才启用复杂网格。
- [ ] 为超长分组增加页内二级导航或横向 chips，优先覆盖 `models` / `tools` / `advanced`。
- [ ] 让 `SettingsSection` / `SettingBlock` / `SettingsRow` 承担大部分响应式差异，避免业务块各自写判断。
- [ ] 语言与主题 tabs 在小屏优先使用 `grid w-full` 等分；只有项目数不固定时才允许横滑。
- [ ] 为 `Switch` 增加整块可点击容器，不让点击范围只剩开关本体。
- [ ] 把高密度伪表格在 `<lg` 时降级为卡片 / definition list，避免手机和平板溢出。
- [ ] `SettingsDemoPanel` 保持单列即可，不为它额外发明复杂响应式结构。

### Phase 6 - 代码收敛与避免过度抽象

**涉及文件**

- `src/components/shell/AppChrome.tsx`
- `src/components/content/ThreadCanvas.tsx`
- `src/components/content/SettingsPanel.tsx`
- `src/styles/app.css`

- [ ] 不创建 `MobileAppChrome` / `TabletAppChrome` / `DesktopAppChrome` 三套组件。
- [ ] 不创建泛化过头的 `ResponsiveLayout` / `AdaptiveContainer` 总控组件。
- [ ] 不在 JS 和 CSS 各维护一份断点常量。
- [ ] 不为单页一次性尺寸抽 token；只有跨 3 处以上复用时才抽。
- [ ] 不在组件里继续新增宽度、边距、触控尺寸硬编码。

### Phase 7 - 测试与验收

**涉及文件**

- `src/lib/responsive.test.ts`
- `src/lib/app-shell.test.ts`
- `src/components/shell/AppChrome.source.test.ts`
- `src/components/shell/Sidebar.source.test.ts`
- `src/components/content/ThreadCanvas.source.test.ts`
- `src/components/content/SettingsPanel.test.ts`

- [ ] 为响应式模型补单测。
- [ ] 为 shell 补源码测试，至少覆盖：
  - `phone / tablet / desktop` 三档判定
  - `compact` 与 `desktop` 两种 sidebar 呈现
  - `compact` 选中后收起侧栏
- [ ] 为 `ThreadCanvas` 补源码测试，至少覆盖：
  - composer 使用 safe-area token
  - 小屏不再依赖桌面化硬编码宽度
  - 次级操作触控高度不低于 44px
- [ ] 为 `SettingsPanel` 补测试，至少覆盖：
  - 小屏单列
  - tabs 等分或可横滑
  - 高密度表格在小屏有降级容器
- [ ] 运行：

```bash
npm run lint
npm run build
node --test --experimental-strip-types src/lib/responsive.test.ts src/lib/app-shell.test.ts src/components/shell/AppChrome.source.test.ts src/components/shell/Sidebar.source.test.ts src/components/content/ThreadCanvas.source.test.ts src/components/content/SettingsPanel.test.ts
```

- [ ] 手工验收以下视口：
  - `390x844`
  - `768x1024`
  - `834x1194`
  - `1024x768`
  - `1280x800`
- [ ] 手工验收口径：
  - 无横向滚动
  - 侧栏可打开 / 收起 / 选中后关闭
  - 输入区不被安全区遮挡
  - 设置项在小屏下可完整点击
  - 所有移动端关键触控目标 `>= 44px`

---

## 给执行 LLM 的硬性约束

- [ ] 这次是收敛与适配，不是视觉翻新。
- [ ] 不新增复杂动画，不用 scale，不做花哨交互。
- [ ] 不改变现有信息架构的核心方向，只补断点、密度和触控可用性。
- [ ] 每完成一项再勾选一项，未验证不得打勾。

---

## Definition Of Done

- [ ] 断点来源统一。
- [ ] shell 在 phone / tablet / desktop 三档下都有明确呈现。
- [ ] 聊天区与设置页不再依赖桌面硬编码宽度。
- [ ] 移动端输入区、安全区、触控尺寸通过验收。
- [ ] lint、build、测试都通过。

