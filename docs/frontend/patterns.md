# 布局与交互模式

本文描述代码里已经落地的布局与交互做法。分层架构不在这里（见将来的 `architecture.md`）。

<a id="shells"></a>
## 1. 桌面壳与移动壳

`src/App.tsx` 用 `useBreakpoint().isSmallScreen`（`< 768px`）在两套壳之间切换。

| | 桌面（`≥ 768px`） | 移动（`< 768px`） |
|---|---|---|
| 根 | `[data-shell-role="app-shell"]`，标题栏 `.desktop-shell-titlebar` + 侧栏（`src/app/shell/*`） | 同一根节点，顶栏 `UnifiedMobileHeader`，导航为统一抽屉（`[data-mobile-unified-drawer]`） |
| 页面顶栏 | 页面自带工具栏 | 页面调用 `useMobileHeader(viewId, config, deps, enabled)`（`src/components/layout/MobileHeaderContext.tsx`）注册到全局唯一顶栏，不自绘第二条 |
| 多栏 | 侧栏 + 工作区 + 检查器 | `MobileSlidingLayout` 三屏滑动 |
| 学习桌面 | `src/features/workbench`（多窗口），激活时隐藏桌面壳侧栏 | — |
| 对话框 | 居中卡片 | DsDialog 自动变底部 sheet |

移动端验收的五条规范（`docs/dev/mobile-uiux-unify/README.md`）：

1. 全局顶栏唯一，通过 `useMobileHeader` 注册。
2. 左侧按钮：主入口页呼出侧栏，子页为返回；页内不再放第二套返回。
3. 右侧快捷动作最多 2 个，每个 ≥ 44px，其余收进“更多”菜单。
4. 窄屏不用桌面组件：可拖拽分栏、宽表（`< md` 改卡片）、只靠 hover 才出现的操作、桌面标题栏/工具栏。
5. 每个页面可进入、可返回（顶栏返回、系统返回键或手势）。

宽度与输入方式分开判断：`< 768` 决定**布局**；`pointer: coarse` 决定**触控尺寸**（iPad 横屏宽度是桌面，但仍要 44px 命中区）。

<a id="touch"></a>
## 2. 触控目标

标准：触屏（`pointer: coarse`）下可交互元素命中区 ≥ 44×44px，即 `--touch-target-size`。移动抽屉导航行同样 `min-height: 44px`（`responsive-utilities.css`）。

按优先级选实现：

1. **用体系组件**：DsButton、Input、SelectTrigger、Tabs、SegmentedControl、Checkbox、Switch、Sheet 关闭钮都已内建 coarse 44px（`src/components/ui/buttonPrimitiveContract.ts` 等）。调用点什么都不用加。
2. **非 button 热区**：`TouchTarget`（或 `touchTargetCoarseClassName`）。
3. **自定义容器**：`min-h-[var(--touch-target-size)]`。
4. **逃生舱**：只有实体撑高会破坏硬布局时，用 `coarseHitClassFor*`，并在 `eslint-rules/coarse-touch-target.allowlist.json` 登记理由。

禁止（`ds-components/coarse-touch-target`，全局 warn，`src/features/chat/components/input-bar/**` error）：业务组件里写 `[@media(pointer:coarse)]:!min-h-11` / `!min-w-11` / `!h-11` / `!min-h-[44px]`，以及裸 `after:-inset-*` / `before:-inset-*` 扩区。`src/components/ui/**` 是体系本体，规则在该目录关闭。

其他：

- 触屏按压反馈用 `.ui-press-coarse`（DsButton 已挂，`--m-press-scale` 0.97）。`docs/CODE_STYLE.md` §5.3 里的“最小点击区域 32px”“`active:scale-95 active:opacity-80`”已过时，以本节为准。
- `responsive-utilities.css` 里的 `.touch-target`、`.touch-row` 类当前没有消费方，不要用。
- 触屏没有可靠 hover：`native-feel/interaction.css` 在 coarse 下强制显示 `group-hover:opacity-100` 的元素、中和 `hover:scale-*`。不要设计只能 hover 才出现的操作。

<a id="safe-area"></a>
## 3. 安全区与键盘

- 变量：`--mobile-safe-area-{top,right,bottom,left}`（`ios-safe-area.css` 全局兜底，`getMobileShellCssVars()` 在壳内写入）。值为 `var(--android-safe-area-*, env(safe-area-inset-*, 0px))`：Android 由 `platform.ts` 注入，iOS 走 `env()`。
- 工具类：`.safe-area-top`、`.safe-area-bottom`、`.safe-area-left`、`.safe-area-right`、`.safe-area-all`（`responsive-utilities.css`）。
- 不要只写 `env(safe-area-inset-bottom)`：Android 上它是 0，要带 `--android-safe-area-*` 前缀回退。
- 顶栏高度：`--mobile-header-height`（56px）、`--mobile-header-total-height`（含顶部安全区）。
- 键盘：`useKeyboardHeight()`（`src/hooks/useKeyboardHeight.ts`）在 Android 返回键盘高度并把 `--keyboard-inset` 写到根；CSS 用 `var(--keyboard-inset, 0px)`。DsDialog 与 shad Dialog 已内建避让。
- iOS 输入框字号：iOS WebKit 上、移动宽度下 `input / textarea / select / contenteditable` 被 `ios-safe-area.css` 强制 ≥ 16px；`inputShellClass` 在 coarse 下用 `text-lg`。自定义输入控件同样不要低于 16px。

<a id="scroll"></a>
## 4. 滚动

- 用 `ScrollArea`（[components.md §8](./components.md#scroll)）。父容器要有确定高度；flex 布局里滚动子项加 `min-h-0`（横向 `min-w-0`）。
- 对话框内容用 `DsDialogBody` 的原生滚动。
- 嵌套滚动区加 `overscroll-contain`，避免把滚动传给外层。根节点已设 `overscroll-behavior: none`（`app.css`，抑制 Android 整页回弹）。
- 编辑器（CodeMirror、Crepe/Milkdown、ProseMirror）和思维导图画布自管滚动，不要外包 ScrollArea。
- 滚动条外观只在 `native-feel/scrollbars.css`；隐藏用 `.scrollbar-none`；不要再写 `::-webkit-scrollbar`。
- 窄屏横向溢出：根节点 `overflow-x: hidden`。宽表在 `< md` 改卡片布局，不要靠横向滚动。

<a id="focus"></a>
## 5. 焦点与键盘

- 全局焦点环：`native-feel/interaction.css` 对 `button, a, [role=button|menuitem|tab|option], [tabindex]` 的 `:focus-visible` 画 `2px solid hsl(var(--ring))`，偏移 2px；输入类偏移 0。DsButton、Switch 另用 `focus-visible:ring-2 ring-ring`。
- 不要写 `outline-none` / `focus:outline-none` 而不给替代焦点样式。`inputShellClass` 的 quiet focus（只换边框与底色）是表单控件的既定例外。
- 模态必须有焦点陷阱并在关闭后归还焦点：用 DsDialog；自绘模态用 `useFocusTrap(isActive, { initialFocus, restoreFocus })`（`src/hooks/useFocusTrap.ts`）。
- ESC 只关最上层：DsDialog、shad Dialog、Popover、AppMenu、Tooltip 都已处理。自绘浮层要同样只在栈顶响应，并检查 `event.defaultPrevented`。
- Android 返回键：自绘浮层打开时 `registerBackHandler(close, BACK_PRIORITY.overlay)`（`src/app/navigation/androidBackCoordinator.ts`；优先级 `overlay` 100、`view` 50、`navigation` 0），关闭时调用返回的注销函数。Radix 浮层有自动兜底。
- 输入法：处理 Enter / Escape 前用 `isComposingKeyEvent(event)`（`src/utils/isComposingKeyEvent.ts`）排除组字中的按键。受控 `Input` 已内建 IME 保护。
- 右键菜单：`AppMenu mode="context"` 已支持 ContextMenu 键与 Shift+F10。
- 只有图标的按钮必须有 `aria-label`；`SegmentedControl` 必须有 `ariaLabel`；对话框必须有 `aria-label` 或 `aria-labelledby`。
- 文本选择：全局默认 `user-select: none`（`tailwind.css`），内容区由 `native-feel/selection.css` 白名单放开；其他需要可复制的文本加 `data-selectable="true"` 或 `select-text`。光标策略在 `native-feel/cursors.css`（chrome 箭头、可点击 pointer、内容 text）。

<a id="reduced-motion"></a>
## 6. 减少动态与透明度

- `ui-motion.css`、`transitions-dev.css`、`interaction.css` 里的类都已在 `prefers-reduced-motion: reduce` 下降级，用它们就不用再处理。
- 自己写的 CSS 动画或过渡：加 `@media (prefers-reduced-motion: reduce)` 降级，或在 Tailwind 里用 `motion-reduce:transition-none` / `motion-reduce:animate-none`（存量 274 处）、`motion-safe:animate-*`。
- framer-motion 没有全局 `MotionConfig`，**不会**自动降级：用 `motionSafe(preset)` 或 `useReducedMotion()`（存量 22 个文件）。
- `prefers-reduced-transparency: reduce` 与 `data-wb-material="reduced|minimal"` 会关闭毛玻璃。新的 `backdrop-filter` 走 `--composer-panel-backdrop-filter` / `--menu-shell-backdrop-filter`，不要写死 `blur()`。

<a id="states"></a>
## 7. 加载、空态、错误

组件见 [components.md §9.1](./components.md#states)。规则：

- 加载占位与最终内容尺寸一致（Skeleton 定好宽高），避免布局跳动。整页加载用 `PageLoadingFallback`，它延迟 220ms 显示。
- 异步按钮：执行中 `disabled` + 旋转图标，防止重复提交。
- 空态：图标 + 一句标题 + 一句说明 + 至多一个主动作；文字走 i18n；标题用真 heading。
- 错误：可恢复的给重试；不可恢复的说明原因与下一步。错误文本用 `getErrorMessage`，不要显示 `[object Object]`。需要用户注意但不阻塞的错误用 `showGlobalNotification('error', …)`。
- 渲染异常由 `ErrorBoundary` 兜底；新的大块独立区域（窗口、面板、嵌入块）自带一层 boundary。

<a id="i18n"></a>
## 8. 界面文字（i18n）

- 所有用户可见文字走 `react-i18next`：`const { t } = useTranslation('<ns>')`。包括 `aria-label`、`title`、`placeholder`、通知文案、空态与错误文案。组件外（工具函数、类组件）用 `i18n.t`（`import i18n from '@/i18n'`）。
- 语言：`zh-CN`、`en-US`（`src/i18n.ts`，`defaultNS: 'common'`，回退 `en-US`）。翻译文件 `src/locales/zh-CN/<ns>.json` 与 `src/locales/en-US/<ns>.json`，两边结构完全一致。
- 共享组件的默认文案用 `common:actions.*`（DsDialog 的关闭、DsAlertDialog 的确认/取消都是这样）。
- 提交前 `npm run check:i18n`（缺键、非字符串叶子、解析失败会失败）；改动较大时 `npm run check:i18n:strict`（再检查 `t()` 引用的键是否存在）。
- 中英文长度差很大：文字按钮不要定死宽度；容器加 `min-w-0`，单行文本用 `truncate` 或 `line-clamp-*`。

<a id="dark-mode"></a>
## 9. 暗色与调色板自查

每个 UI 改动都在下面几种状态下看一遍（应用内：设置 → 外观；组件审计页 `/button-audit.html` 只有亮/暗切换）：

- 亮色与暗色。
- 至少两个调色板，包括 `bright-pink`（亮色下 `--primary-foreground` 是深色）。
- 界面字号 85% 与 130%（`--font-size-scale`）。
- 一个窄屏（< 768px）和一个触屏宽屏（coarse + ≥ 1024px）。

看的内容：

- 没有写死的颜色：hex、`rgb()`、`bg-white`、`text-black`、`bg-gray-*`。底色和文字用语义 token，暗色自动跟随。
- 实心主色/状态色底上的文字用对应 `*-foreground`。
- 浮层在暗色下仍能分出层次（用 `shadow-floating` 等 token，暗色强度已加大）。
- Tooltip 里的次级文字用 `--tooltip-text-*`。
- `dark:` 变体只在没有合适 token 时使用（存量 681 处），优先补 token。
- SVG / 插图用 `currentColor` 或 token，不要内嵌固定颜色。
