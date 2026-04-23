# Repository Guidelines

- 永远回复中文。
- 像一位高绩效的资深 UI/UX 设计师。表达言简意赅，直截了当，注重用户体验和设计落地。
- 倾向于选择简单、易于理解、适合用户需求的界面解决方案。设计低复杂度、易于交互、清晰美观的界面，避免过度设计或添加复杂的动画、多余的元素或庞大的设计系统。
- 保持设计简洁，交互清晰，视觉元素明确。除非能明显提升用户体验，否则避免使用花哨的效果。
- 先从原始需求出发，不默认用户已经完全想清楚目标、约束和实现路径。
只有当需求存在关键歧义，且不同理解会导致明显不同方案或较高错误成本时，才先停下来澄清；否则基于最合理解释继续，并明确说明假设。
当需要给出修改或重构方案时，遵循以下原则：
默认只围绕用户明确提出的目标设计方案，不擅自扩展业务目标，不引入替代业务路径。
优先给出满足目标的最小完整方案，而不是补丁式兼容方案；但如果“最短路径”与“非补丁”冲突，应优先选择不会引入结构性错误的最小正确方案。
不做与当前需求无关的兜底、降级或额外分支设计；但为保证逻辑闭合，允许加入必要的输入约束、状态检查和边界保护。
输出方案前，按输入、处理流程、状态变化、输出、上下游影响进行链路检查；对无法验证的部分必须明确标注假设和未验证前提，不得将推测表述为已确认事实。

---

## 技术栈（锁定）

| 层级 | 技术 | 版本 |
|------|------|------|
| 框架 | React | 19 |
| 构建 | Vite | 7 |
| 语言 | TypeScript | 5.9+ |
| 样式 | Tailwind CSS | v4 |
| 组件原语 | Radix UI | 最新 |
| 组件体系 | shadcn/ui（new-york 风格） | — |
| 类名工具 | CVA + clsx + tailwind-merge | — |
| 图标 | Phosphor Icons（@phosphor-icons/react） | — |
| 桌面外壳 | Tauri | 2.x |
| Lint | ESLint | 9 |

> **禁止引入**：Next.js、Emotion、styled-components、Ant Design、MUI、其他 CSS-in-JS 方案。新增依赖须经讨论。

---

## UI/UX 设计规范

### 设计原则
1. **Mobile First**：所有布局和交互从移动端视口出发设计，逐步增强至桌面端。组件先保证触屏可用，再为鼠标/键盘优化。
2. **克制**：不加多余元素。每个像素都要有存在理由。
3. **一致**：同类操作使用统一的视觉语言和交互模式。
4. **跨平台原生感**：macOS 遵循标题栏/侧边栏/毛玻璃惯例；Windows 遵循 Mica/Acrylic 视觉语言；移动端遵循系统手势与安全区域。
5. **可读性优先**：信息密度适中，层级清晰，留白充足。

### 跨平台与响应式

#### 设计策略

- **Mobile First**：CSS 默认写移动端样式，通过断点向上覆盖。
- 触控目标最小 44×44px（移动端），桌面端可缩至 32×32px。
- 侧边栏在移动端折叠为 Sheet/Drawer，桌面端常驻。
- 表单控件移动端全宽，桌面端限制最大宽度。

#### 断点（Tailwind）

| 断点 | 宽度 | 典型设备 |
|------|------|----------|
| 默认 | < 640px | 手机 |
| `sm` | ≥ 640px | 大屏手机/小平板 |
| `md` | ≥ 768px | 平板 |
| `lg` | ≥ 1024px | 笔记本/桌面 |
| `xl` | ≥ 1280px | 大桌面 |

> 桌面 Tauri 窗口最小 980×680，移动端通过 WebView 适配。

#### 平台差异处理

| 特性 | macOS | Windows | 移动端 |
|------|-------|---------|--------|
| 标题栏 | 原生 + 毛玻璃 | 系统标题栏 | 无（状态栏适配） |
| 窗口背景 | 半透明可选 | Opaque | 纯色 |
| 滚动条 | 系统悬浮式 | 系统悬浮式 | 系统原生 |
| 安全区域 | — | — | `env(safe-area-inset-*)` |

### 色彩系统

所有颜色通过 CSS 变量定义于 `src/styles/app.css`，支持 Light / Dark 双主题。**禁止硬编码颜色值**，必须使用 Tailwind 映射的语义化 token。

#### 语义化色彩 Token（Tailwind class 中使用）

| 用途 | Tailwind class | 说明 |
|------|---------------|------|
| 页面底色 | `bg-background` / `text-foreground` | 全局背景和默认文本 |
| 卡片 | `bg-card` / `text-card-foreground` | 内容卡片 |
| 弹出层 | `bg-popover` / `text-popover-foreground` | Dropdown / Tooltip / Dialog |
| 主色 | `bg-primary` / `text-primary-foreground` | 主要按钮、链接、强调 |
| 次要 | `bg-secondary` / `text-secondary-foreground` | 次要按钮、辅助区域 |
| 静音 | `bg-muted` / `text-muted-foreground` | 辅助文本、禁用态 |
| 强调 | `bg-accent` / `text-accent-foreground` | 选中态、hover 底色 |
| 交互 | `bg-interactive-hover` / `bg-interactive-selected` | 列表项悬停/选中 |
| 危险 | `bg-destructive` / `text-destructive-foreground` | 删除、警告 |
| 边框 | `border-border` | 所有分割线 |
| 输入框 | `bg-input` | 输入框底色 |
| 焦点环 | `ring-ring` | Focus ring |
| 遮罩 | `bg-overlay` | 模态遮罩 |

#### 侧边栏专用 Token

`bg-sidebar` / `text-sidebar-foreground` / `text-sidebar-muted` / `border-sidebar-border` / `bg-sidebar-accent` / `bg-sidebar-hover`

#### Shell 窗口 Token

`bg-shell-backdrop` / `bg-shell-panel` / `bg-shell-panel-strong` / `border-shell-rim` / `bg-shell-float` / `bg-shell-titlebar`

#### 主题色调预设（8 套）

aurora-blue / lavender-violet / forest-green / sunset-orange / rose-pink / teal-cyan / soft-tone（默认）/ paper-grain / custom

> 色调通过 `src/lib/theme.ts` 管理，运行时注入 `--primary` 等变量。

### 字体系统

#### 字体栈

| 标识 | 字体栈 | 适用场景 |
|------|--------|---------|
| system（默认） | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif` | 界面通用 |
| sans | `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif` | 中文阅读 |
| serif | `"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", serif` | 长文阅读 |
| mono | `"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace` | 代码展示 |

> 通过 `--app-font-family` CSS 变量动态切换，管理入口为 `src/lib/app-settings.ts`。

#### 字号规范

基础字号 `16px`，通过 `--app-font-scale`（90%–120%，步长 5%）全局缩放。

| 用途 | Tailwind class | 换算（scale=1） | 使用场景 |
|------|---------------|----------------|---------|
| 极小 | `text-[11px]` | 11px | 徽标、辅助标签 |
| 小字 | `text-xs` | 12px | 次要信息、时间戳 |
| 辅助 | `text-sm` | 14px | 侧边栏、表单标签 |
| 正文 | `text-base` | 16px | 主内容区域 |
| 小标题 | `text-lg` | 18px | 区块标题 |
| 标题 | `text-xl` | 20px | 页面标题 |
| 大标题 | `text-2xl` | 24px | 重要页面标题 |

> **禁止**使用 `text-3xl` 及更大字号。界面内所有字号保持在 11px–24px 范围内。

### 间距与布局

| 用途 | 推荐值 | 说明 |
|------|--------|------|
| 组件内边距 | `p-2`–`p-4`（8px–16px） | 紧凑型桌面应用 |
| 区块间距 | `gap-3`–`gap-6`（12px–24px） | 内容块之间 |
| 页面边距 | `p-4`–`p-6`（16px–24px） | 页面内容区 |
| 列表项间距 | `gap-1`（4px） | 紧凑列表 |
| 表单元素间距 | `gap-2`–`gap-3`（8px–12px） | 表单字段之间 |

### 圆角

| 用途 | Tailwind class | 说明 |
|------|---------------|------|
| 按钮/输入框 | `rounded-lg`（8px） | 标准控件 |
| 卡片 | `rounded-3xl`（24px） | 大面积卡片容器 |
| 小元素 | `rounded-md`（6px） | 标签、徽标 |
| 头像/图标容器 | `rounded-full` | 圆形 |

### 阴影

| 用途 | Tailwind class |
|------|---------------|
| 卡片 | `shadow-lg shadow-black/5` |
| 弹出层 | `shadow-xl shadow-black/8` |
| 浮动按钮 | `shadow-md shadow-black/5` |

> **禁止**使用 `shadow-2xl` 及强烈阴影。保持视觉轻盈。

### 交互状态

- **Hover**：使用 `bg-interactive-hover` 或透明度变化（`hover:opacity-80`），**禁止** scale 或过度动画。移动端无 hover，改为 `active:` 状态。
- **Active/Selected**：使用 `bg-interactive-selected`。
- **Focus**：使用 `ring-ring` focus ring，`focus-visible:ring-2`。
- **Disabled**：`opacity-50 pointer-events-none`。

### 动画与过渡规范

#### 核心原则

- 动画服务于**反馈和引导**，不是装饰。
- 所有过渡必须 ≤ 300ms，避免让用户等待。
- 尊重 `prefers-reduced-motion`：开启时所有动画应降级为即时切换。

#### 允许的过渡

| 场景 | Tailwind class | 时长 | 说明 |
|------|---------------|------|------|
| 颜色变化 | `transition-colors duration-150` | 150ms | 按钮 hover、背景切换 |
| 透明度 | `transition-opacity duration-150` | 150ms | 元素淡入淡出 |
| 弹出层进入 | `transition-opacity duration-200` | 200ms | Dialog/Dropdown 出现 |
| 侧边栏展开 | `transition-[width] duration-200` | 200ms | 侧边栏折叠/展开 |
| Sheet 滑入 | `transition-transform duration-250` | 250ms | 仅限 Sheet/Drawer 组件 |

#### 缓动函数

| 用途 | 值 | 说明 |
|------|-----|------|
| 默认 | `ease-out` | 大多数进入动画 |
| 退出 | `ease-in` | 元素消失 |
| 交互反馈 | `ease-in-out` | 切换/折叠 |

#### 禁止清单

- **禁止** `transform` 缩放动画（`scale-95` → `scale-100` 等）
- **禁止** `bounce`、`spring`、弹性缓动
- **禁止** 超过 300ms 的过渡时长
- **禁止** 无限循环动画（loading spinner 除外）
- **禁止** 页面级路由切换动画
- **禁止** `animation-delay` 制造的「瀑布流」效果

#### Reduced Motion 适配

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0ms !important; animation-duration: 0ms !important; }
}
```

> Tailwind 中使用 `motion-reduce:transition-none` 按需控制。

### 组件使用规范

| 组件 | 来源 | 使用说明 |
|------|------|---------|
| Button | `src/components/ui/button.tsx` | 统一使用 CVA 变体：default / secondary / outline / ghost / destructive |
| Card | `src/components/ui/card.tsx` | 内容卡片容器，自带圆角和阴影 |
| Dialog | `src/components/ui/dialog.tsx` | 模态对话框，基于 Radix UI |
| DropdownMenu | `src/components/ui/dropdown-menu.tsx` | 右键/下拉菜单 |
| Input / TextArea | `src/components/ui/input.tsx` / `textarea.tsx` | 表单输入 |
| Switch | `src/components/ui/switch.tsx` | 开关，基于 Radix UI |
| Tabs | `src/components/ui/tabs.tsx` | 标签页切换 |
| Tooltip | `src/components/ui/tooltip.tsx` | 悬浮提示 |
| Sheet | `src/components/ui/sheet.tsx` | 侧边抽屉 |
| Surface | `src/components/ui/surface.tsx` | 表面容器 |

> **新增组件**优先从 shadcn/ui 获取，使用 `npx shadcn@latest add <component>`。自定义组件放 `src/components/` 对应子目录。**禁止引入其他组件库**。

### 图标规范

- 统一使用 **Phosphor Icons**（`@phosphor-icons/react`）。
- 默认尺寸 `size={18}`，侧边栏导航 `size={20}`，大图标 `size={24}`。
- 默认粗细 `weight="regular"`，活跃态可用 `weight="fill"`。
- **禁止混用** Lucide、Heroicons 或其他图标库。

---

## 项目结构与模块组织

- `src/App.tsx`：应用入口组件。
- `src/main.tsx`：React 挂载入口。
- `src/components/ui/`：基础 UI 组件（shadcn/ui）。
- `src/components/layout/`：布局组件。
- `src/components/shell/`：桌面外壳组件（标题栏、侧边栏等）。
- `src/components/content/`：内容区组件。
- `src/components/settings/`：设置页组件。
- `src/components/theme/`：主题 Provider 与切换逻辑。
- `src/lib/`：工具函数、配置逻辑（`utils.ts`、`theme.ts`、`app-settings.ts` 等）。
- `src/styles/`：全局样式与 CSS 变量（`app.css`）。
- `public/`：静态资源。
- `src-tauri/`：Tauri 桌面外壳配置与 Rust 代码。
- `scripts/`：构建脚本与合约测试。
- 生成物：`.next/`、`out/`、`dist/`（勿提交或手改）。

## 构建、测试与本地开发命令

- `npm run dev`：本地开发（Vite，含热更新）。
- `npm run build`：生产构建。
- `npm run preview`：预览生产构建。
- `npm run lint`：ESLint 规则检查。
- `npm run tauri:dev`：启动桌面应用开发（Tauri + Vite）。
- `npm run tauri:build`：构建桌面安装包。

## 代码风格与命名约定

- 语言：TypeScript；缩进 2 空格；尽量无 `any`；优先函数式与无副作用组件。
- ESLint：基于 `react-hooks` 与 `react-refresh`。提交前执行 `npm run lint`（可加 `-- --fix`）。
- 组件命名：PascalCase（如 `Button.tsx`）；Hook 用 `useXxx.ts`；工具 `*.ts`。
- 样式：Tailwind CSS v4 + CSS 变量。类名拼接使用 `cn()`（`src/lib/utils.ts`）。
- CSS 变量定义集中在 `src/styles/app.css`，**禁止在组件中内联定义新 CSS 变量**。

## 测试指南

- 合约测试位于 `scripts/` 目录，使用 Node.js 内置 `--test` runner。
- 单元测试旁置于源文件旁：`*.test.ts(x)`。
- 新增/变更模块目标覆盖率 ≥80%。

## 提交与 Pull Request 规范

- 提交信息（Conventional Commits）：`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `ci:`。
- 可选作用域：`shell|settings|content|ui|lib|theme`。
- 提交前本地通过：`npm run lint && npm run build`。
- 桌面相关改动建议验证 `npm run tauri:dev`。
- 不提交生成物、机密与 `.env*`。

## 安全与配置

- 环境变量：使用 `.env.local`（不提交），前端仅暴露 `VITE_` 前缀变量。
- Tauri：修改 `src-tauri` 配置前请评估权限与打包影响；避免在渲染进程存放敏感信息。

## GSD 项目上下文

- 当前 GSD 项目文档位于 `.planning/`。
- 当前目标：在不复制三套 UI 的前提下，完成 `study-ui` 的 phone / tablet / desktop 响应式适配。
- 下一步优先阅读：`.planning/PROJECT.md`、`.planning/REQUIREMENTS.md`、`.planning/ROADMAP.md`。
- 执行顺序：先做响应式环境与 layout policy，再做 root dataset/token，再改 shell/sidebar，随后改 ThreadCanvas/SettingsPanel，最后统一触控尺寸和验收。
