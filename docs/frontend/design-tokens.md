# 设计令牌（Design Tokens）

本文列出代码里实际存在的每一族 token：名字、值、出口、什么时候用。名字和值以源码为准（基线 `04932be8`）。

<a id="files"></a>
## 1. 文件与加载顺序

| 文件 | 内容 |
|---|---|
| `src/styles/shadcn-variables.css` | **基础层**：灰度、状态色、调色板（`--primary` 等）、字号/字重/行高/字距、字体栈、尺寸、圆角、聊天线程宽度 |
| `src/styles/theme-colors.css` | **语义层**：surface / text / border / shell / sidebar / button / input / dialog / menu / composer / tooltip / scrollbar 等完整颜色值；阴影；`--z-*` 层级 |
| `src/styles/transitions-dev.css` | 动效时长与缓动（`--dropdown-*`、`--modal-*`、`--panel-*`、`--ease-*`、`--m-*`） |
| `src/styles/ui-motion.css` | 开合/入场动画类（`.ui-*`），只消费 transitions-dev token |
| `src/styles/typography.css` | 全局排版、根字号、`h1`–`h6` |
| `src/styles/ios-safe-area.css`、`responsive-utilities.css` | 安全区变量与工具类、移动抽屉、触控类 |
| `src/styles/native-feel/*.css` | 焦点环、默认过渡、选区、光标、滚动条 |
| `tailwind.config.js` | 上述 token 的 Tailwind 出口 |
| `src/config/zIndex.ts`、`src/config/breakpoints.ts` | JS 侧层级与断点常量 |
| 领域内 token | `src/features/chat/styles/{chat,chat-beautify,motion}.css`、`src/styles/notes-typography.css`、`src/features/workbench/styles/workbench.tokens.css`：只在本领域用，不要跨域引用 |

`src/App.tsx` 的引入顺序：`overlayscrollbars.css` → `tailwind.css`（内含 transitions-dev、ui-motion、native-feel、prose-lite）→ `shadcn-variables.css` → `theme-colors.css` → `shared/styles/index.css`（app.css、deep-student.css 等存量全局样式）→ `ios-safe-area.css` → `responsive-utilities.css` → … → `typography.css` → `shadcn-overrides.css`。

<a id="color"></a>
## 2. 颜色

### 2.1 三层结构与写法

| 层 | 定义处 | 值的形态 | 怎么用 |
|---|---|---|---|
| 基础层 | `shadcn-variables.css` | **HSL 通道**，如 `--primary: 215 72% 42%` | 必须包一层：`hsl(var(--primary))`、`hsl(var(--primary) / 0.5)` |
| 语义层 | `theme-colors.css` | **完整颜色**，如 `--surface-elevated: hsl(var(--card))` | 直接 `var(--surface-elevated)`；**不要**再包 `hsl()` |
| Tailwind 出口 | `tailwind.config.js` `theme.extend.colors` | — | `bg-primary`、`text-muted-foreground`、`border-border`、`bg-warning/10` |

语义层没有 Tailwind 键，TSX 里用任意值：`bg-[color:var(--surface-panel)]`、`text-[color:var(--text-secondary)]`、`border-[color:var(--border-soft)]`。

例外：`--success-bg`、`--warning-muted` 等状态辅助 token 和 `--neutral` 是“通道 + 透明度”字符串（`var(--success) / 0.14`），用法是 `hsl(var(--success-bg))`。`--brand-primary` 也是通道值（见 §2.4）。

**禁止**：TSX/CSS 里写 hex、`rgb()`、Tailwind 原色板（`bg-gray-100`、`text-blue-500`、`bg-white`、`text-black`）。分类色用 `--settings-nav-accent-*`，状态色用 `success/warning/info/danger`。存量见 [README 欠账表](./README.md#debt)。

### 2.2 基础层（`shadcn-variables.css`）

所有调色板共享，纯中性灰（色相 0）。改中性色只改这里。

| token | 亮色 | 暗色（`:root.dark`） | Tailwind |
|---|---|---|---|
| `--background` | `0 0% 100%` | `0 0% 9%` | `bg-background` |
| `--foreground` | `220 9% 18%` | `0 0% 96%` | `text-foreground` |
| `--card` / `--card-foreground` | `0 0% 99%` / 同 foreground | `0 0% 12%` / 同 foreground | `bg-card` |
| `--popover` / `--popover-foreground` | `0 0% 99%` | `0 0% 12%` | `bg-popover` |
| `--secondary` / `-foreground` | `0 0% 98%` | `0 0% 14%` | `bg-secondary` |
| `--muted` | `0 0% 94%` | `0 0% 14%` | `bg-muted` |
| `--muted-foreground` | `220 6% 42%` | `0 0% 60%` | `text-muted-foreground` |
| `--accent` / `-foreground` | `0 0% 93%` | `0 0% 15%` | `bg-accent` |
| `--border` | `0 0% 88%` | `0 0% 18%` | `border-border`（`*` 默认边框色） |
| `--input` | `0 0% 95%` | `0 0% 14%` | `border-input` |
| `--nav-background` | `0 0% 95%` | `0 0% 12%` | 无；经 `--sidebar` 消费 |
| `--titlebar-background` | `0 0% 96%` | `0 0% 11%` | 无 |
| `--destructive` / `-foreground` | `0 65% 51%` / `0 0% 100%` | `0 55% 45%` / `0 0% 100%` | `bg-destructive`、`text-destructive` |
| `--success` | `152 60% 36%` | `152 55% 42%` | `bg-success/10`、`text-success` |
| `--warning` | `38 70% 45%` | `38 65% 50%` | `bg-warning/10`、`text-warning` |
| `--info` | `217 70% 50%` | `217 65% 55%` | `bg-info/10`、`text-info` |
| `--danger` / `-foreground` | `= --destructive` | 同 | `bg-danger`、`text-danger` |

状态色前景：亮色 `--success/warning/info-foreground` 都是 `0 0% 100%`；暗色是深色（`144 100% 10%` 等）。实心底上的文字一律配 `*-foreground`，不要写 `text-white`。

红色有两个名字：`destructive`（`text-destructive` 662 处、`bg-destructive` 299 处）与 `danger`（64 / 38 处），值相同（注释：“避免同屏双红”）。**新代码用 `destructive`**；`danger` 只在与 `info/success/warning` 并列的状态映射里使用。

`--status-working/paused/blocked/idle/completed` 已定义但当前没有消费方。

<a id="palette"></a>
### 2.3 调色板（`data-theme-palette`）与暗色

由 `src/hooks/useTheme.ts` 的 `applyThemeToDom` 写到 `<html>`：

- `class="dark"`（Tailwind `darkMode: 'class'`）、`data-theme="dark|light"`、`data-theme-palette="<palette>"`、`style.colorScheme`；`<body>` 上 `dark-theme` / `light-theme`。
- 模式 `light | dark | auto`（auto 跟随 `prefers-color-scheme`）。存储键 `dstu-theme-mode`、`dstu-theme-palette`、`dstu-theme-custom-color`。
- 亮暗翻转时临时挂 `theme-transitioning`，过渡时长 `--theme-transition-dur: 220ms`（`src/shared/styles/app.css`）；`prefers-reduced-motion` 下跳过。

调色板**只**覆写 `--primary`、`--primary-foreground`、`--ring`、`--brand-primary`、`--brand-primary-dark`、`--primary-color`，中性色、边框、状态色不受影响（`shadcn-variables.css` 设计约束注释）。

| `data-theme-palette` | 名称（CSS 注释） | 亮色 `--primary` | 暗色 `--primary` |
|---|---|---|---|
| `default`（无属性时也生效） | 静海蓝 | `215 72% 42%` | `214 64% 72%` |
| `purple` | 墨藤紫 | `262 52% 42%` | `262 52% 74%` |
| `green` | 林影绿 | `154 45% 31%` | `154 42% 68%` |
| `orange` | 琥珀橙 | `24 78% 35%` | `32 72% 70%` |
| `pink` | 胭脂红 | `342 58% 39%` | `340 58% 72%` |
| `bright-pink` | 明亮粉 | `346 94% 72%` | `346 94% 72%` |
| `teal` | 青岩蓝 | `184 54% 30%` | `184 48% 68%` |
| `muted` | 雾灰 | `220 30% 38%` | `220 24% 70%` |
| `paper` | 米纸 | `24 35% 32%` | `36 40% 70%` |
| `custom` | 自选色 | `useTheme.ts` `generateCustomThemeVars` 运行时内联写入同一组 6 个变量 | 同左 |

`--primary-foreground` 不总是白色：所有暗色档和亮色 `bright-pink` 是深色，亮色 `paper` 是米白。`bg-primary` 必须配 `text-primary-foreground`。

`theme-colors.css` 里的 `--button-primary-*`、`--brand-*`、`--input-shell-focus`、`--accent-primary` 都从 `--primary` 派生，随调色板自动变化，不需要按调色板单独写。

暗色覆写写在 `:root.dark { … }`；只有派生比例在暗色下不同的语义 token 才在 `theme-colors.css` 的 `:root.dark` 块里重写（如阴影强度、按钮 mix 比例、`--settings-nav-accent-*`）。

其他会改 token 的根属性：`data-sidebar-translucent`、`data-macos-vibrancy`（侧栏材质，`theme-colors.css`）、`data-wb-material="reduced|minimal"`（关闭 CSS 毛玻璃，`--composer-panel-backdrop-filter: none`）、`data-font-smoothing`（`typography.css`）。媒体查询 `prefers-contrast: more` 抬高 `--settings-nav-accent-*` 对比度，`prefers-reduced-transparency: reduce` 把 `--overlay` 与侧栏改为不透明。

<a id="semantic"></a>
### 2.4 语义层（`theme-colors.css`）

所有语义 token 定义在 `:where(:root)`（特异性 0），组件或领域作用域可以直接覆盖。括号里是当前 `var()` 引用次数，0 表示已定义但无人使用，不要以它为范例。

**表面**

| token | 值 | 用途 |
|---|---|---|
| `--surface-root` | `hsl(var(--background))` | 页面底（30） |
| `--surface-elevated` | `hsl(var(--card))` | 卡片、面板（57） |
| `--surface-muted` | `hsl(var(--muted))` | 次级底、分段控件槽（36） |
| `--surface-panel` / `-muted` / `-strong` | elevated 与 root 的 mix；`-strong` = elevated 92% | 面板族；`-strong` 用于 hover、激活 tab（10 / 6 / 16） |
| `--surface-divider` | border 55% | 分隔线（1） |
| `--surface-nav`、`--surface-root-strong`、`--surface-overlay(-strong)`、`--glass-*` | — | 无消费方 |
| `--overlay` | 亮 `hsl(var(--background) / 0.78)`，暗 `/ 0.84` | 模态遮罩（`bg-[color:var(--overlay)]`） |
| `--interactive-hover` / `--interactive-selected` | foreground 10% | 行/按钮 hover 与选中（504 / 38） |

**文字与边框**

| token | 值 | 用途 |
|---|---|---|
| `--text-primary` | `hsl(var(--foreground))` | 主文字（111） |
| `--text-secondary` | foreground 70% + muted-foreground 30% | 次级文字（87） |
| `--text-muted` | `hsl(var(--muted-foreground))` | 辅助文字（157） |
| `--border-default` / `--border-soft` / `--border-strong` | border / border 70% / border 90% + foreground 10% | 23 / 86 / 7 |

Tailwind 写法里 `text-muted-foreground`（4110 处）与 `text-[color:var(--text-muted)]` 等价，二者都可；`text-secondary` 没有对应 Tailwind 类，用 `text-[color:var(--text-secondary)]`。注意 `typography.css` 定义了全局类 `.text-muted`（muted-foreground + 12px 字号），它不是 Tailwind 的 `text-muted`（= `--muted` 底色），新代码不要用这个类名。

**壳层（桌面 shell / 侧栏）**：方向 C 扁平单色，`--shell-backdrop/panel/titlebar/surface/float` 全部等于 `hsl(var(--background))`；唯一灰区是侧栏 `--sidebar = hsl(var(--nav-background))`。导航族 `--shell-navigation-{surface,panel,foreground,muted,border,row-foreground,section-label}`，工作区 `--shell-workspace-{surface,panel,border}`，检查器 `--shell-inspector-*`，控件 `--shell-control-{surface,border,hover,active}`，窗口关闭钮 `--shell-window-close-*`，侧栏行 `--sidebar-quiet-{hover,active,active-foreground}`。只在壳层组件里用。

**组件族**

| 前缀 | 消费方 | 说明 |
|---|---|---|
| `--button-plain-*`、`--button-destructive-*` | DsButton（`buttonPrimitiveContract.ts`） | DsButton 实际只用这两族 |
| `--button-primary-{surface,border,foreground,hover,active}` | 选中/强调态边框与文字 | 约 20 处 |
| `--button-utility-*`、`--button-danger-*`、`--button-tonal-*` | 少量 | `--button-prominent-*`、`--button-outline-*` 无消费方 |
| `--input-shell-{surface,border,focus}` | Input/Textarea/Select（`shad/inputShell.ts`） | |
| `--dialog-shell-{surface,border}` | DsDialog、shad Sheet | |
| `--mobile-sheet-{surface,foreground,muted-foreground,border,header-border,handle,shadow,scrim}` | 移动 sheet | `--mobile-sheet-scrim` 无消费方 |
| `--menu-shell-*` | AppMenu | 继承 composer 族；圆角 16px / 行 12px；`--menu-shell-font-size: var(--font-size-ui)` |
| `--composer-panel-*` | 聊天输入栏与其弹层 | `chat-beautify.css` 在聊天作用域内覆写 surface/border/shadow |
| `--tooltip-surface` / `--tooltip-foreground` | 反色气泡 | 富内容用 `--tooltip-text-secondary`、`--tooltip-text-muted`、`--tooltip-divider`、`--tooltip-chip-*`、`--tooltip-track`；**不要**在气泡里用 `--text-secondary`（对比度会掉到 1.3–2.5:1） |
| `--scrollbar-*` | `native-feel/scrollbars.css` | 10px 交互道 / 4px 视觉滑块 |

**分类与领域色**

- `--settings-nav-accent-{amber,blue,slate,purple,orange,green,sky,pink,coral,teal,indigo,violet}`：只表达“类别”，不表达状态；亮/暗/高对比三档。新增分类色复用这些档位。
- `--citation-source-{rag,multimodal,memory,web-search}`：通道值，引用来源。
- `--resource-icon-*`：Learning-hub 资源图标插画，仅 `src/features/learning-hub/icons/ResourceIcons.tsx` 使用。
- 品牌：`--brand-secondary`、`--brand-accent`、`--brand-gradient(-hover)`、`--brand-50/100/200/300/600`、`--brand-outline` 是完整颜色。`--brand-primary` 是通道值（= `var(--primary)`），CSS 里写 `hsl(var(--brand-primary))`。Tailwind 的 `brand.primary` 映射成 `var(--brand-primary)` 会得到无效颜色，**不要用 `bg-brand-primary` / `text-brand-primary`**，用 `bg-primary`。

<a id="chat"></a>
### 2.5 聊天 / 输入栏专用

| token | 定义处 | 值 / 用途 |
|---|---|---|
| `--chat-thread-ratio` / `--chat-thread-max-w` | `shadcn-variables.css` | `80` / `max(44rem, calc(1% * ratio))`；消息列、输入栏、空态共享宽度。用 `max-w-thread`，不要写 `max-w-[44rem]`。比例由 `src/config/threadWidthConfig.ts` 内联覆写 |
| `--chat-block-{radius,surface,surface-muted,border}`、`--chat-code-{inline-bg,block-surface}`、`--chat-table-header-surface` | `shadcn-variables.css` | 消息内内容块，圆角 12px |
| `--chat-thinking-{surface,header-surface,hover-surface,border}` | `theme-colors.css` | 思维链面板 |
| `--chat-thinking-font-size` | 全局 `var(--font-size-sm)`；`.chat-v2` 内覆写为 `--chat-md-compact-font-size`（0.9375rem） | |
| `--chat-*` 排版与间距（`--chat-body-font-size`、`--chat-md-*`、`--chat-spacing-*` …） | `src/features/chat/styles/chat.css`，作用域 `.chat-v2` | 只在聊天内用 |
| `--chat-motion-{fast,base,slow,ease,ease-material}` | `src/features/chat/styles/motion.css` | 别名：150ms / 200ms / `--resize-dur` / `--ease-standard` |

<a id="typography"></a>
## 3. 字体与字号

### 3.1 字号

`tailwind.config.js` 在 `theme.extend.fontSize` 里按键覆盖了下列类，值都是 `calc(Npx * var(--font-size-scale))`。注意 `text-base` 是 14px，不是 Tailwind 默认的 16px。

| 类 | 变量 | 基准 | 用途 |
|---|---|---|---|
| `text-2xs` | `--font-size-2xs` | 10px | 极小角标；移动端不用 |
| `text-xs` | `--font-size-xs` | 11px | 桌面密集 UI 下限；**移动端不得使用** |
| `text-sm` | `--font-size-sm` | 12px | 次级说明、紧凑控件；`h6` |
| `text-caption` | `--m-text-caption` | 12px | 时间戳、徽标计数；**移动端最小可读字号** |
| `text-ui` | `--font-size-ui` | 13px | 桌面控件标签（DsButton、菜单、对话框描述） |
| `text-base` | `--font-size-base` | 14px | 正文、列表行；移动正文下限；`h5` |
| `text-md` | `--font-size-md` | 15px | |
| `text-lg` | `--font-size-lg` | 16px | 移动端输入框（iOS 低于 16px 聚焦会放大页面）；`h4` |
| `text-xl` | `--font-size-xl` | 18px | `h3` |
| `text-2xl` | `--font-size-2xl` | 20px | `h2` |
| `text-3xl` | `--font-size-3xl` | 24px | `h1` |

- `text-4xl` 及以上没有被覆盖，仍是 Tailwind 默认 rem 值，不在体系内，不要用。
- 这些字号类只设字号，**不带行高**；需要时显式加 `leading-*`。
- 确需任意值时写 `text-[length:var(--font-size-ui)]`；`text-[13px]` 被 `ds-components/no-arbitrary-font-size` 拦截（`src/components/ui/**` 为 error，其余 warn）。
- 缩放：设置 → 外观 → 界面字号写 `--font-size-scale`（`src/config/fontConfig.ts` `applyFontSizeToDocument`，范围 0.85–1.3，预设 85/90/100/110/120/130%）。
- 领域字号：笔记编辑器 `--notes-body-size`（16px × scale）与 `--notes-heading-*`（`notes-typography.css`）；聊天 `--chat-body-font-size`（= `--font-size-lg`）。只在本领域用。

### 3.2 字重、行高、字距

| Tailwind | 变量 | 值 |
|---|---|---|
| `font-normal` / `font-medium` / `font-semibold` / `font-bold` | `--font-weight-*` | 400 / 500 / 600 / 700 |
| `leading-tight` / `snug` / `normal` / `relaxed` | `--line-height-*` | 1.25 / 1.375 / 1.5 / 1.625 |
| `tracking-tight` / `normal` / `wide` | `--letter-spacing-*` | -0.01em / 0 / 0.01em |

`leading-none`、`leading-6` 等其他 Tailwind 默认值没被替换，可以用但不随 token 调整。

### 3.3 字体栈

| Tailwind | 变量 | 值 |
|---|---|---|
| `font-sans` | `--font-family` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, emoji`；用户在设置里选字体时由 `applyFontToDocument` 内联覆写 |
| `font-cn` | `--font-family-cn` | 加 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC"`；`typography.css` 对 `:lang(zh)` 元素自动应用 |
| `font-mono` | `--font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`；`code/pre/kbd/samp` 默认 |

`--app-font-family`、`--font-family-sidebar-study-ui`、`.font-sidebar-study-ui`、`.font-serif-custom` 是历史遗留，新代码不用。

<a id="root-size"></a>
### 3.4 根字号与 rem

`typography.css` 把根字号设为桌面 `14px × scale`；在 `max-width: 767.98px` **或** `pointer: coarse` 下为 `16px × scale`。所以所有 rem 值（Tailwind 间距、`h-10`、`--radius`、`--button-height`）在桌面比 Tailwind 文档小 12.5%，并随界面字号缩放。需要固定像素的几何（触控目标）用 px token，如 `--touch-target-size`。

<a id="sizing"></a>
## 4. 尺寸与间距

间距直接用 Tailwind 默认刻度（未扩展），记住 §3.4 的根字号。语义尺寸 token（`shadcn-variables.css`，`app.css`）：

| token | 值 | 用途 |
|---|---|---|
| `--touch-target-size` = `--control-height-touch` | 44px | 触控命中下限；`min-h-[var(--touch-target-size)]` |
| `--control-height-compact` | 32px | |
| `--button-height` / `-sm` / `-lg` | 2rem / 1.875rem / 2.25rem | DsButton 桌面（`lg:` 以上）高度；桌面根 14px 时为 28 / 26.25 / 31.5px |
| `--button-icon-size` | 2rem | 桌面图标钮边长 |
| `--button-padding-x` / `-sm` / `-lg` | 0.875rem / 0.75rem / 1rem | |
| `--size-shell-control` / `--size-shell-window-control` | 32px / 34px | 壳层控件、窗口按钮 |
| `--size-shell-touch-target` / `-lg` | 36px / 40px | 壳层专用，**低于** 44px 触控标准，不要当触控目标用 |
| `--space-shell-layout-gap` / `-section-gap` / `-control-gap` | 14px / 18px / 2px | 壳层间距 |
| `--shell-titlebar-height` | `var(--desktop-titlebar-height, 40px)` | `app.css` |
| `--shell-navigation-width` | `var(--sidebar-width, 272px)` | `app.css` |
| `--mobile-header-height` / `--mobile-header-total-height` | 56px / 56px + 顶部安全区 | `src/app/shell/mobileShell.ts` `getMobileShellCssVars()` 写入 |
| `--mobile-safe-area-{top,right,bottom,left}` | Android 注入值，回退 `env(safe-area-inset-*)` | 见 [patterns.md §安全区](./patterns.md#safe-area) |
| `--keyboard-inset` | 运行时 px | `src/hooks/useKeyboardHeight.ts` 写到根；CSS 里 `var(--keyboard-inset, 0px)`，不要在样式文件里声明 |
| `--chat-thread-max-w` | 见 §2.5 | `max-w-thread` |
| `--menu-shell-padding` / `-row-padding-y` / `-row-padding-x` / `-row-gap` | 6 / 7 / 10 / 8px | AppMenu |

<a id="radius"></a>
## 5. 圆角

| Tailwind | 变量 | 值 | 用途 |
|---|---|---|---|
| `rounded-sm` / `rounded-md` / `rounded-lg` | `--radius` 派生 | `calc(--radius - 4px)` / `- 2px` / `--radius`（0.5rem） | 通用小元素；Popover、Tooltip |
| `rounded-control` | `--radius-shell-control` | 12px | 输入框、Tabs 触发器、菜单行 |
| `rounded-row` | `--radius-shell-row` | 14px | 导航行 |
| `rounded-toolbar` | `--radius-shell-toolbar` | 16px | 工具栏、AppMenu、SegmentedControl 外框 |
| `rounded-shell` | `--radius-shell-panel` | 18px | 面板 |
| `rounded-dialog` | `--radius-shell-dialog` | 22px | 对话框、Sheet |
| `rounded-pill` | — | 999px | 胶囊按钮（替代 `rounded-[999px]`） |
| 无 | `--radius-card` | 12px | 业务卡片（`shad/Card` 已用）；`rounded-[var(--radius-card)]` |
| 无 | `--button-radius` | 9px | DsButton |
| 无 | `--radius-shell-window-control` | 10px | 窗口按钮 |
| 无 | `--chat-block-radius` | 12px | 聊天内容块 |

`rounded`、`rounded-xl`、`rounded-2xl`、`rounded-full` 未被覆盖（Tailwind 默认 rem 值）。`shadow-sm`、`shadow-md` 等默认阴影类同样未被覆盖，不要用，见 §6。

存量写法 `rounded-[var(--radius-shell-control)]`（121 处）多于 Tailwind 键（8 处）。二者等价；新代码用 Tailwind 键（`rounded-control`），需要 `calc()` 时才写任意值。

<a id="shadow"></a>
## 6. 阴影

阴影色基 `--shadow-base: 0 0% 0%`（始终黑），强度由 `--shadow-strength-*` 控制。暗色只改强度（`theme-colors.css` `:root.dark`），不要为暗色另写一串 `box-shadow`。

| Tailwind | 变量 | 配方 | 亮 / 暗强度 | 用途 |
|---|---|---|---|---|
| `shadow-soft` | `--shadow-shell-soft` | `0 12px 24px` | 0.04 / 0.32 | 激活 tab、轻浮起 |
| `shadow-shell` | `--shadow-shell-panel` | `0 16px 32px` | 0.05 / 0.40 | 面板 |
| `shadow-floating` | `--shadow-shell-floating` | `0 18px 36px` | 0.08 / 0.54 | 对话框、Sheet、菜单、输入栏面板 |
| `shadow-pressed` | `--shadow-shell-pressed` | `0 8px 20px` | 0.05 / 0.36 | |
| 无 | `--shadow-content-subtle` / `-soft` / `-elevated` | `0 1px 3px` / `0 2px 8px` / `0 6px 18px` | 0.05 / 0.10 / 0.06（暗 0.28 / 0.44 / 0.40） | 内容区小卡片；`shadow-[var(--shadow-content-soft)]` |
| 无 | `--mobile-sheet-shadow` | `0 -12px 34px` | 0.10 / 0.52 | 底部 sheet |
| 无 | `--text-shadow-contrast-{subtle,medium,strong}` | | | 图上文字 |

旧别名 `--shadow-card`（= soft）、`--shell-shadow-soft`、`--shell-shadow-active` 只给存量用。基础控件默认无阴影：Popover、shad Dialog、Tooltip、Card 都写了 `shadow-none`；浮层用 `shadow-floating`。

<a id="z-index"></a>
## 7. z-index 层级

两张表：`src/config/zIndex.ts`（`Z_INDEX`）与 `theme-colors.css`（`--z-*`，Tailwind 出口 `z-dropdown` 等）。改任何一档都要同时改两处并 grep 消费方。

| 层 | `Z_INDEX` | `--z-*` | Tailwind | 用于 |
|---|---|---|---|---|
| fullscreenContent | 70 | — | — | 覆盖主内容的全屏层（低于输入栏） |
| inputBar / inputBarPopover / inputBarInner / inputBarDragOverlay | 100 / 150 / 200 / 300 | — | — | 聊天输入栏及其内部 |
| （AppMenu 默认） | — | — | — | `.app-menu-content` 在 `AppMenu.css` 写死 110；包在 `OverlayLayerProvider` 内时改用 baseZ + 50 |
| popover | 1000 | `--z-dropdown` 1000 | `z-dropdown` | Portal 下拉基线；`OverlayLayer` 默认 baseZ |
| — | — | `--z-sticky` 1020 | `z-sticky` | 吸顶 |
| mobileHeader / desktopTitlebar | 1100 | — | — | 移动顶栏、桌面标题栏 |
| composerPanel | 1150 | — | — | 输入栏组合面板 |
| overlay | 2000 | `--z-overlay` 2000 | `z-overlay` | 侧栏/抽屉遮罩 |
| drawer | 2500 | — | — | 阶梯锚点，无 TS 消费方 |
| modal | 3000（内容 3001） | `--z-modal` 3000 | `z-modal` | DsDialog、shad Dialog |
| — | — | `--z-popover` 3100 | `z-popover` | 必须压过模态的编辑器弹层（crepe wikilink / mention） |
| sheet | 4000（shad Select 内容 = sheet + 10） | — | — | shad Sheet |
| toast | 5000 | `--z-toast` 5000 | `z-toast` | UnifiedNotification |
| imageViewer | 6000 | `--z-image-viewer` 6000 | 无 | 全屏图片查看器 |
| contextMenuBackdrop / contextMenu | 9000 / 9050 | — | — | Portal 右键菜单 |
| topmost | 9999 | — | — | 紧急覆盖，尽量不用 |
| tooltip | 10000 | `--z-tooltip` 10000 | `z-tooltip` | shad Tooltip |
| systemTitlebar | 2147483000 | — | — | macOS 虚拟标题栏 |
| — | — | `--z-debug` 2147483647 | `z-debug` | 调试层 |

注意同名不同值：`Z_INDEX.popover` = 1000（对应 `--z-dropdown`），`--z-popover` = 3100。

规则：

- portal 到 `body` 或 `fixed` 全屏的层：TS 里用 `style={{ zIndex: Z_INDEX.modal }}`，或 Tailwind token 类 `z-modal`。不要写 `z-[N]` 魔数（存量 35 处），也不要用 `z-50`（Tooltip 曾因 `z-50` 被弹窗盖住）。
- 组件自身 stacking context 内的局部叠放可以用 Tailwind 默认 `z-0`…`z-50`。
- 自绘浮层里再开菜单：外层包 `<OverlayLayerProvider baseZ={Z_INDEX.modal}>`（`src/components/shared/OverlayLayer.tsx`），内部 AppMenu 自动抬高。

<a id="breakpoints"></a>
## 8. 断点

`tailwind.config.js` `screens` 与 `src/config/breakpoints.ts` `BREAKPOINTS` 一致：

| 键 | px | 说明 |
|---|---|---|
| `xs` | 480 | 仅 Tailwind 工具类，无 JS hook |
| `sm` | 640 | |
| `md` | 768 | **移动壳切换点**：`< 768` 为移动布局 |
| `lg` | 1024 | DsButton / Input 从触控高度压缩到桌面高度 |
| `xl` | 1280 | |
| `2xl` | 1536 | |

- 判断“是否移动布局”只用 `useIsMobile()` 或 `useBreakpoint().isSmallScreen`（`src/hooks/useBreakpoint.ts`，`!(min-width: 768px)`）或 `MOBILE_SHELL.breakpointMax`（767）。不要用 `SCREEN_SIZES.mobile`（0–639，语义不同）。
- CSS 里写 `@media (max-width: 767.98px)`，不要写 `767px`（Android 缩放下视口可能是 767.x）。
- 宽度和指针类型是两回事：宽屏触屏（iPad 横屏）用 `@media (pointer: coarse)` / `[@media(pointer:coarse)]:` 处理触控尺寸。
- 新增断点必须同时改两处文件。

<a id="motion"></a>
## 9. 动效

### 9.1 CSS token（`transitions-dev.css`）

| 场景 | token | 值 |
|---|---|---|
| 下拉/菜单 | `--dropdown-open-dur` / `--dropdown-close-dur` / `--dropdown-pre-scale` / `--dropdown-closing-scale` / `--dropdown-ease` | 250ms / 150ms / 0.97 / 0.99 / `cubic-bezier(0.22, 1, 0.36, 1)` |
| 模态 | `--modal-open-dur` / `--modal-close-dur` / `--modal-scale` / `--modal-ease` | 250ms / 150ms / 0.96 / 同上 |
| 面板/Sheet | `--panel-open-dur` / `--panel-close-dur` / `--panel-ease` | 400ms / 350ms / 同上 |
| 页面切换 | `--page-slide-dur` / `--page-fade-dur` / `--page-slide-distance` / `--page-slide-ease` | 200ms / 200ms / 8px |
| 卡片尺寸 | `--resize-dur` / `--resize-ease` | 220ms |
| 折叠 | `--acc-expand` / `--acc-collapse` / `--acc-chevron` | 250ms |
| 图标/文字/数字切换 | `--icon-swap-*`、`--text-swap-*`、`--digit-*` | 200ms / 200ms / 500ms |
| 通用缓动 | `--ease-standard`（= `--dropdown-ease`）/ `--ease-material` / `--ease-shell` | `(0.22,1,0.36,1)` / `(0.4,0,0.2,1)` / `(0.25,0.1,0.25,1)` |
| 移动按压 | `--m-press-dur` / `--m-press-scale` / `--m-press-ease` | 120ms / 0.97 / standard |
| 移动内联面板 | `--m-sheet-dur` / `--m-sheet-distance` | 260ms / 16px |
| 滑动手势提示 | `--m-swipe-hint-dur` / `--m-swipe-hint-distance` | 1200ms / 64px |
| 移动页面推入 | `--m-page-push-dur` / `--m-page-push-ease` | = `--page-slide-*` |

Tailwind 出口：`ease-standard`、`animate-sweep`（Skeleton）、`animate-chat-rise-in`、`animate-chat-fade-in`。

### 9.2 CSS 动画类（`ui-motion.css`、`transitions-dev.css`）

| 类 | 用途 |
|---|---|
| `.ui-fade-in` / `.ui-fade-out` | 遮罩淡入淡出（modal token） |
| `.ui-zoom-fade-in` / `.ui-zoom-fade-out` | 下拉、Popover（`--ui-zoom-origin` 调原点） |
| `.ui-slide-in-{top,bottom,left,right}` / `.ui-slide-out-*` | Sheet 边缘滑入 |
| `.ui-rise-in` / `.ui-drop-in`（及 `-out`） | 挂载入场 4px 上升/下降（tab 面板、横幅） |
| `.ui-slide-fade-in` | 自定义偏移入场（`[--ui-enter-x:32px]`） |
| `.ui-tooltip-in` / `.ui-tooltip-out` | Tooltip，按 `data-side` 定方向 |
| `.ui-state-colors` | 激活态颜色平滑切换 |
| `.ui-press` / `.ui-press-coarse` | 按压缩放；`-coarse` 只在触屏生效，DsButton 已挂 |
| `.ui-slide-up-panel` | 底部内联面板（非全屏 sheet） |
| `.t-resize`、`.t-panel-slide`、`.t-dropdown`、`.t-icon-swap`、`.t-text-swap`、`.t-acc*` | transitions-dev 的过渡钩子 |

`*-out` 类只在元素带 `data-state="closed"` 时生效。非 Radix 组件用 `UiPresence` 或 `useMotionPresence` 保留退场节点（见 [components.md](./components.md#presence)）。这些类都在文件末尾做了 `prefers-reduced-motion` 降级。keyframes 只动 `opacity` 与独立的 `translate` / `scale` 属性，不会覆盖内联 `transform` 定位。

全局默认（`native-feel/interaction.css`）：按钮、链接、`role=button/menuitem/tab/option` 的 `background-color/color/border-color/opacity/box-shadow` 150ms 过渡；按钮 hover 不缩放（`transform: none !important`，需缩放的元素加 `data-allow-hover-scale`）；按钮 `:active` 下移 0.5px。

### 9.3 framer-motion 预设（`src/styles/motion-springs.ts`）

| 导出 | 参数 | 用于 |
|---|---|---|
| `springSnap` | spring 400 / 30 | 按钮态、图标切换、小元素归位 |
| `springSheet` | spring 380 / 30 | 面板、对话框、底部 sheet 入场 |
| `springSoft` | spring 300 / 26 | 列表重排、拖拽让位 |
| `tweenFast` | tween 0.15s，`[0.22, 1, 0.36, 1]` | 透明度、颜色（与 `--ease-standard` 同曲线） |
| `transitionInstant` | `{ duration: 0 }` | reduced-motion 替代 |
| `motionSafe(t)` / `prefersReducedMotion()` | | 一次性读取偏好；需要响应式用 `useReducedMotion()`（framer）或 `useMediaQuery('(prefers-reduced-motion: reduce)')` |

`src/styles/motion-variants.ts` 只剩 `newMessageVariants`（MessageList）。

### 9.4 CSS 还是 framer-motion

- **默认用 CSS**：开合、hover、挂载入场、颜色切换。framer-motion 只有约 54 个文件在用。
- **用 framer-motion 的情形**：弹簧物理（`springSheet` 的 DsDialog）、拖拽手势（DsDialog 移动 sheet 下滑关闭）、布局动画（SegmentedControl 滑块）、`AnimatePresence` 管理的列表进出。
- 用 framer-motion 时必须从 `motion-springs.ts` 取预设，不手写 stiffness/damping；必须处理 reduced-motion（`motionSafe()` 或 `useReducedMotion()`）。应用没有全局 `<MotionConfig reducedMotion="user">`，framer 动画不会自动降级。

<a id="add-token"></a>
## 10. 新增 token

1. 先在本文和 `src/styles/` 里找有没有现成的。语义层大多数需求已经有了。
2. 选文件：
   - 新的基础颜色（HSL 通道）→ `shadcn-variables.css`，`:root` 与 `:root.dark` **两处都写**。需要 Tailwind 类时在 `tailwind.config.js` `colors` 加 `hsl(var(--x))`；要支持 `/10` 透明度时用 `hsl(var(--x) / <alpha-value>)`。
   - 语义颜色（完整值）→ `theme-colors.css` 的 `:where(:root)` 块，从基础层派生（`hsl(var(--card))`、`color-mix(in hsl, …)`）。只有暗色派生比例不同才在 `:root.dark` 块重写。用 `color-mix` 的 token 若必须在老 Android WebView 上有底色，先写实色兜底，再在文件末尾 `@supports (background: color-mix(…))` 块升级（参照 `--surface-panel`）。
   - 调色板只允许覆写 `--primary`、`--primary-foreground`、`--ring`、`--brand-primary`、`--brand-primary-dark`、`--primary-color`。新调色板要在 `shadcn-variables.css` 加亮/暗两块，在 `useTheme.ts` 的 `ThemePalette`、`PRESET_PALETTES`、`PALETTE_PREVIEW_COLORS` 登记。
   - 字号 → `shadcn-variables.css`，形式必须是 `calc(Npx * var(--font-size-scale))`，并在 `tailwind.config.js` `fontSize` 加键。
   - 尺寸、圆角 → `shadcn-variables.css`；需要 Tailwind 键时加到 `borderRadius` / `maxWidth` 等。
   - 阴影 → `theme-colors.css`，配方用 `hsl(var(--shadow-base) / var(--shadow-strength-x))`，并在 `:root.dark` 给强度。
   - 动效 → `transitions-dev.css`；framer 预设 → `motion-springs.ts`。
   - z-index → `src/config/zIndex.ts`，如需 CSS/Tailwind 同步加 `--z-*` 与 `tailwind.config.js` `zIndex`。
   - 只属于一个领域 → 该领域的样式文件，作用域选择器下，用领域前缀（`--chat-*`、`--notes-*`、`--wb-*`）。
3. 命名：`--{族}-{角色}[-{状态}]`，例如 `--surface-panel-strong`、`--button-primary-hover`、`--menu-shell-row-active`。前景色用 `-foreground` 后缀；状态用 `-hover` / `-active` / `-selected` / `-focus`；尺寸档用 `-sm` / `-lg`。
4. 自查：亮/暗、至少两个调色板（含 `bright-pink`，它的 `--primary-foreground` 在亮色下是深色）、`prefers-contrast: more`（若涉及分类色）；`npm run lint:css`。
5. 同一个 PR 更新本文。
