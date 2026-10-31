# UI PR 评审清单

每个改动界面的 PR 都跑一遍。“规则”列是执行它的 lint；没有规则的靠人看。lint 为 `warn` 的项，新代码同样不允许新增。

先跑：`npm run lint`、`npm run lint:css`、`npm run typecheck`、`npm run check:i18n`。

## 组件

- [ ] 按钮用 `DsButton`，没有新的原生 `<button>`，没有导入 `shad/Button`。[§](./components.md#button) · `ds-components/no-native-button`（warn）、`no-restricted-imports`（error）
- [ ] `DsButton` 的 `variant` 只用 `ghost` / `danger` / `nav`；没指望 `primary` 是实心色。[§](./components.md#button)
- [ ] 没有通过 `className` 改按钮高度或触控尺寸。[§](./components.md#button)
- [ ] 模态用 `DsDialog` / `DsAlertDialog`，不用 `shad/Dialog`、`window.confirm`、`window.alert`。[§](./components.md#dialog) · `no-alert`（error）
- [ ] 菜单用 `AppMenu`；自绘浮层里的菜单外层有 `OverlayLayerProvider`。[§](./components.md#popover)
- [ ] Tooltip 从 `@/components/ui/shad/Tooltip` 导入，没有新的 `CommonTooltip` / `react-tooltip`。[§](./components.md#tooltip) · `ds-components/no-legacy-tooltip`（error）
- [ ] 表单控件用 `Input` / `Textarea` / `Select` / `Checkbox` / `Switch`；选择控件按“2–4 项 → SegmentedControl、表单 → Select、需搜索 → Combobox、工具栏 → AppSelect”选。[§](./components.md#form)
- [ ] 滚动区域用 `ScrollArea`，不是 `CustomScrollArea`；没有新的 `::-webkit-scrollbar`。[§](./components.md#scroll)
- [ ] 通知用 `showGlobalNotification`。[§](./components.md#feedback)
- [ ] 图标来自 `@phosphor-icons/react`（厂商 logo 用 `ProviderIcon`），尺寸按 16 / 14 / 12 约定，颜色继承 `currentColor`。[§](./components.md#icons)

## Token 与样式

- [ ] 没有 `text-[Npx]`；字号用 `text-2xs/xs/sm/caption/ui/base/md/lg/xl/2xl/3xl`。[§](./design-tokens.md#typography) · `ds-components/no-arbitrary-font-size`（`src/components/ui/**` error，其余 warn）
- [ ] 移动端没有 `text-xs`（11px）及更小的正文；输入框 ≥ 16px。[§](./design-tokens.md#typography)
- [ ] 没有 hex / `rgb()` / Tailwind 原色板（`bg-gray-*`、`text-blue-*`、`bg-white`、`text-black`）；用语义 token。[§](./design-tokens.md#color)
- [ ] 基础层 token 包了 `hsl()`，语义层 token 没有重复包。[§](./design-tokens.md#color)
- [ ] 红色用 `destructive`；没有 `bg-brand-primary` / `text-brand-primary`。[§](./design-tokens.md#semantic)
- [ ] 圆角、阴影用 token（`rounded-control/toolbar/dialog/pill`、`shadow-floating` 等），暗色没有另写 `box-shadow`。[§](./design-tokens.md#radius) [§](./design-tokens.md#shadow)
- [ ] z-index 用 `Z_INDEX.*` 或 `z-modal` 等 token 类，没有新的 `z-[N]`，portal 层没有用 `z-50`。[§](./design-tokens.md#z-index)
- [ ] 断点判断用 `useIsMobile` / `isSmallScreen`；CSS 写 `max-width: 767.98px`。[§](./design-tokens.md#breakpoints)
- [ ] 内联 `style` 只放运行时计算值。[§](./README.md#debt)
- [ ] 新 CSS 不用 `!important`、嵌套 ≤ 3 层、类名 kebab-case。· stylelint `declaration-no-important`、`max-nesting-depth`、`selector-max-specificity`
- [ ] 新增 token 放对了文件，亮/暗两处都写，同 PR 更新了 `design-tokens.md`。[§](./design-tokens.md#add-token)

## 动效

- [ ] 开合与状态切换用 `ui-motion.css` 的类或 transitions-dev token，没有写死时长和曲线。[§](./design-tokens.md#motion)
- [ ] 用 framer-motion 有理由（弹簧、拖拽、布局动画），参数取自 `motion-springs.ts`，并用 `motionSafe()` / `useReducedMotion()`。[§](./design-tokens.md#motion)
- [ ] 自写的 CSS 动画在 `prefers-reduced-motion` 下降级。[§](./patterns.md#reduced-motion)

## 移动与触控

- [ ] coarse 下可交互元素 ≥ 44×44；没有散点 `[@media(pointer:coarse)]:!min-h-11` 或裸 `after:-inset-*`。[§](./patterns.md#touch) · `ds-components/coarse-touch-target`（全局 warn，`input-bar` error）
- [ ] 移动页面用 `useMobileHeader` 注册顶栏，右侧动作 ≤ 2 个；窄屏没有宽表、可拖拽分栏、只靠 hover 的操作。[§](./patterns.md#shells)
- [ ] 贴边元素处理了安全区（`--mobile-safe-area-*` / `.safe-area-*`），没有只写 `env()`。[§](./patterns.md#safe-area)
- [ ] 输入区考虑了键盘遮挡。[§](./patterns.md#safe-area)

## 可访问性与键盘

- [ ] 只有图标的按钮有 `aria-label`；对话框有 `aria-label(ledby)`；`SegmentedControl` 有 `ariaLabel`。[§](./patterns.md#focus)
- [ ] 没有去掉焦点环而不给替代样式。[§](./patterns.md#focus)
- [ ] 自绘浮层：ESC 只关栈顶、注册了 Android 返回键、模态有焦点陷阱并归还焦点。[§](./patterns.md#focus)
- [ ] 处理 Enter / Escape 前排除了输入法组字。[§](./patterns.md#focus)
- [ ] 需要可复制的文字放开了选择（`data-selectable="true"` / `select-text`）。[§](./patterns.md#focus)

## 文案与状态

- [ ] 所有可见文字（含 `aria-label`、`placeholder`、通知）走 i18n，`zh-CN` 与 `en-US` 都加了。[§](./patterns.md#i18n) · `npm run check:i18n`
- [ ] 中英文都不溢出：没有定死宽度的文字按钮，长文本有 `truncate` / `min-w-0`。[§](./patterns.md#i18n)
- [ ] 有加载、空、错误三态，错误文本经 `getErrorMessage`。[§](./patterns.md#states)

## 目测

- [ ] 亮色、暗色、两个调色板（含 `bright-pink`）、字号 85% 与 130%、窄屏、触屏宽屏都看过。[§](./patterns.md#dark-mode)
