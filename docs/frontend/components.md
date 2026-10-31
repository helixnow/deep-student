# 组件选用

每种需求只有一个标准组件。表里“旧实现”只为存量保留：改到相关代码时可以顺手迁移，**新代码不得使用**。频次是基线 `04932be8` 上导入该模块的非测试文件数。

<a id="summary"></a>
## 1. 速查表

| 需求 | 标准组件（导入路径） | 旧实现 / 不要用 |
|---|---|---|
| 按钮、图标按钮 | `DsButton`（`@/components/ui/DsButton`，426 文件） | `@/components/ui/shad/Button`（lint error）、原生 `<button>`（lint warn，745 处） |
| 模态对话框 | `DsDialog` + `DsDialogHeader/Title/Description/Body/Footer`（`@/components/ui/DsDialog`，49 文件） | `@/components/ui/shad/Dialog`（3 文件） |
| 确认框 | `DsAlertDialog`（同上） | `window.confirm`、`window.alert`（`no-alert` error） |
| 侧栏抽屉 | `@/components/ui/unified-sidebar`（`UnifiedSidebar`、`SidebarSheet`、`SidebarDrawer`、`MobileSidebarLayout`） | — |
| 边缘面板（非侧栏） | `Sheet` 族（`@/components/ui/shad/Sheet`，4 文件） | 组件审计页标为“遗留”，只在 DsDialog / unified-sidebar 都不合适时用 |
| 轻量弹出层 | `Popover`、`PopoverTrigger`、`PopoverContent`（`@/components/ui/shad/Popover`） | — |
| 下拉菜单、右键菜单 | `AppMenu` 族（`@/components/ui/app-menu`） | 各功能私有 ContextMenu（`DesktopContextMenu`、`TreeContextMenu` 等）只为存量 |
| 气泡提示 | `Tooltip`、`TooltipTrigger`、`TooltipContent`、`TooltipProvider`（`@/components/ui/shad/Tooltip`） | `CommonTooltip`（`@/components/shared/CommonTooltip`，lint error）、`react-tooltip`（lint error） |
| 表单下拉选择 | `Select` 族（`@/components/ui/shad/Select`） | `ModernSelect`、原生 `<select>` |
| 选项多需搜索 | `Combobox`（`@/components/ui/shad/Combobox`） | — |
| 工具栏紧凑选择 | `AppSelect`（`@/components/ui/app-menu`） | — |
| 2–4 项互斥切换 | `SegmentedControl`（`@/components/ui/SegmentedControl`） | — |
| 单行输入 | `Input`（`@/components/ui/shad/Input`） | 原生 `<input>` |
| 多行输入 | `Textarea`（`@/components/ui/shad/Textarea`） | 原生 `<textarea>` |
| 标签 | `Label`（`@/components/ui/shad/Label`） | — |
| 复选框 | `Checkbox`（`@/components/ui/shad/Checkbox`） | 原生 `<input type="checkbox">` |
| 开关 | `Switch`（`@/components/ui/shad/Switch`） | 手写 mini 开关 |
| 标签页 | `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent`（`@/components/ui/shad/Tabs`） | — |
| 滚动区域 | `ScrollArea`（`@/components/ui/scroll-area`） | `CustomScrollArea`（`@/components/custom-scroll-area`，`@deprecated`，207 文件）、`@/components/ui/shad/ScrollArea`（再包一层 CustomScrollArea，13 文件） |
| 全局通知 | `showGlobalNotification`（`@/components/UnifiedNotification`，251 文件） | `useNotification`（`@/hooks/useNotification`，局部 state）、`window.alert` |
| 页内警告 | `Alert`、`AlertTitle`、`AlertDescription`（`@/components/ui/shad/Alert`） | — |
| 徽标 | `Badge`（`@/components/ui/shad/Badge`） | — |
| 卡片容器 | `Card` 族（`@/components/ui/shad/Card`） | — |
| 骨架屏 | `Skeleton`（`@/components/ui/shad/Skeleton`） | — |
| 进度条 | `Progress`（`@/components/ui/shad/Progress`） | 私有进度环 |
| 非按钮触控热区 | `TouchTarget`（`@/components/ui/TouchTarget`） | `.touch-target` / `.touch-row` CSS 类（零消费方）、散点 `[@media(pointer:coarse)]:!min-h-11` |
| 非 Radix 浮层的开合动画 | `UiPresence`（`@/components/ui/UiPresence`）、`useMotionPresence`（`@/hooks/useMotionPresence`） | 手写 setTimeout 卸载 |
| 模型/服务商图标 | `ProviderIcon`（`@/components/ui/ProviderIcon`） | 直接导入 `@lobehub/icons` |
| 类名合并 | `cn`（`@/utils/cn`，twMerge + clsx） | `cn`（`@/lib/utils`，只拼接），见 §2.3 |

<a id="button"></a>
## 2. 按钮

### 2.1 DsButton

```tsx
import { DsButton } from '@/components/ui/DsButton';

<DsButton size="sm" onClick={save}>{t('actions.save')}</DsButton>
<DsButton variant="danger" size="sm" onClick={remove}>{t('actions.delete')}</DsButton>
<DsButton iconOnly size="sm" aria-label={t('actions.refresh')}><ArrowClockwise size={16} /></DsButton>
```

| prop | 值 | 说明 |
|---|---|---|
| `variant` | `ghost` · `danger` · `nav`；另有 `default`(默认) `primary` `secondary` `outline` `utility` `shell` `success` `warning` `destructive` | 2026-09 裁定后只有两套油漆：**透明 ghost** 与 **红色 danger**（`destructive` 同 danger）。`primary`、`outline`、`default` 等名字保留只为不改调用点，渲染与 ghost 完全一样。`nav` 是侧栏导航行（整行、左对齐）。新代码写 `ghost` 或 `danger`，不要以为 `primary` 会是实心主色 |
| `size` | `sm` · `md`(默认) · `lg` · `icon` · `default` | `< lg`：高 `--touch-target-size`（44px），svg 18px（图标钮 20px）。`≥ lg`：`--button-height-sm/(默认)/-lg`。`pointer: coarse` 下无论宽度都保底 44px |
| `iconOnly` | boolean | 正方形；`size="icon"` 等价。**必须给 `aria-label`**（开发模式会 `console.warn`） |
| `type` | 默认 `button` | 表单提交时显式写 `type="submit"` |

基础类（`buttonBaseClassName` + DsButton 自身）已包含：`ui-press-coarse` 触屏按压、`text-ui` 字号、`focus-visible:ring-2 ring-ring`、禁用态降透明度与 `cursor-not-allowed`、`[&_svg]:text-inherit`。不要在调用点重复写这些。

### 2.2 不走 DsButton 的按钮

| 场景 | 做法 |
|---|---|
| 桌面壳层图标钮 | `shellIconButtonClassName`；导航行 `shellNavButtonClassName`（都在 `buttonPrimitiveContract.ts`） |
| 链接样式 | `buttonToneClassNames.link`（DsButton 不接受 `link` variant） |
| 聊天发送/停止圆钮 | 输入栏私有实现（组件审计页 `composer-send` 族），不要复制到别处 |
| Radix / AppMenu / Popover 的 trigger | 用 `asChild` 包一个 DsButton |

`no-native-button` 在 `src/components/ui/shad/**`、`src/promptkit/**`、`src/debug-panel/plugins/**`、`src/components/dev/**`、测试文件里关闭。

### 2.3 className 覆盖与 `cn`

`DsButton` 和 `src/components/ui/**` 的大多数基元从 `@/lib/utils` 导入 `cn`，它只拼接、不合并。传入 `className="h-8"` 不会移除基础类里的 `h-[var(--touch-target-size)]`，结果取决于 CSS 输出顺序。所以：

- 不要通过 className 改按钮高度；选合适的 `size`。触控高度由体系保证，不要覆盖（`coarse-touch-target` 会报）。
- 业务代码（`src/features/**` 等）新写的 `cn` 从 `@/utils/cn` 导入（`docs/CODE_STYLE.md` §4）。存量 354 个文件用 `@/lib/utils`、101 个用 `@/utils/cn`；不要为此批量改导入。
- 用 `cva` 管理新组件的变体（`shad/Sheet.tsx`、`shad/Badge.tsx`、`shad/Alert.tsx` 是范例）。

<a id="dialog"></a>
## 3. 对话框与面板

### 3.1 DsDialog

```tsx
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';

<DsDialog open={open} onOpenChange={setOpen} aria-labelledby={titleId} maxWidth="max-w-md">
  <DsDialogHeader><DsDialogTitle id={titleId}>{t('…')}</DsDialogTitle></DsDialogHeader>
  <DsDialogBody>…</DsDialogBody>
  <DsDialogFooter>
    <DsButton size="sm" onClick={() => setOpen(false)}>{t('actions.cancel')}</DsButton>
    <DsButton size="sm" onClick={submit}>{t('actions.confirm')}</DsButton>
  </DsDialogFooter>
</DsDialog>
```

| prop | 默认 | 说明 |
|---|---|---|
| `open` / `onOpenChange` | 必填 | 受控 |
| `closeOnOverlay` | `true` | 点遮罩关闭 |
| `showClose` | `true` | 右上角关闭钮（文案 `common:actions.close`） |
| `maxWidth` | `max-w-lg` | Tailwind 宽度类 |
| `aria-label` / `aria-labelledby` | — | 二选一，必须给 |

已内建，不要在调用点重做：portal 到 `body`、`Z_INDEX.modal`；焦点陷阱与关闭后焦点归还（`useFocusTrap`）；ESC 只关栈顶弹窗；Android 返回键关闭（`BACK_PRIORITY.overlay`）；`< 768px` 变为底部 sheet（顶部把手可下滑关闭、底部安全区）；Android 键盘避让；`springSheet` 入场。

`DsDialogBody` 默认原生滚动（`overflow-y-auto overscroll-contain scroll-area--native`）。`overlayScroll` 只在超长虚拟列表等少数场景开，注释里写了原因：入场缩放期间 OverlayScrollbars 会读到错误尺寸。

### 3.2 DsAlertDialog

`title`、`description`、`icon`、`confirmText`（默认 `common:actions.confirm`）、`cancelText`（默认 `common:actions.cancel`）、`confirmVariant`（默认 `danger`）、`confirmSize`（默认 `sm`）、`onConfirm`、`onCancel`、`secondaryText` / `onSecondary` / `secondaryVariant`、`loading`、`disabled`、`children`。不能点遮罩关闭；ESC 与返回键等同取消；`role="alertdialog"`，标题/描述已接 `aria-labelledby` / `aria-describedby`。

### 3.3 Sheet 与侧栏

- 移动端的模态内容直接用 DsDialog，它在窄屏自动变 sheet。
- 应用侧栏、页内导航抽屉用 `@/components/ui/unified-sidebar`；移动三屏布局用 `MobileSlidingLayout`（`src/components/layout/MobileSlidingLayout.tsx`）。
- `shad/Sheet`（Radix Dialog）：`side` = `top|bottom|left|right`（默认 `right`），`hideCloseButton`，`overlayClassName`；层级 `Z_INDEX.sheet`；开合用 `ui-slide-in/out-*`。只在上面两种都不合适时使用。
- 底部内联面板（不是全屏 sheet）用 `.ui-slide-up-panel` 入场类。

<a id="popover"></a>
## 4. Popover 与菜单

### 4.1 Popover（自研，非 Radix）

`Popover`：`open`、`onOpenChange`。`PopoverTrigger`：`asChild`（不传则渲染裸 `<button type="button">`，没有 DsButton 的触控高度与焦点样式；总是 `asChild` 包 DsButton）。`PopoverContent`：`align`（`start|center|end`，默认 `center`）、`side`（`top|bottom`，默认 `bottom`）、`sideOffset`（8）、`collisionPadding`（8）、`portal`（默认 `true`）。

内建：ESC、外点关闭、Android 返回、打开时收起所有 Tooltip、视口碰撞翻转、`.ui-zoom-fade-in/out`、在对话框内时 portal 进 `[data-overlay-container]` 并取 `max(Z_INDEX.popover, 父对话框 z + 1)`。外观平面（`rounded-lg border-border/40 bg-popover shadow-none`）。

### 4.2 AppMenu

```tsx
import { AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem, AppMenuSeparator } from '@/components/ui/app-menu';

<AppMenu>
  <AppMenuTrigger asChild>
    <DsButton iconOnly size="sm" aria-label={t('actions.more')}><DotsThree size={16} /></DsButton>
  </AppMenuTrigger>
  <AppMenuContent align="end" width={220}>
    <AppMenuItem icon={<PencilSimple size={16} />} onClick={rename}>{t('actions.rename')}</AppMenuItem>
    <AppMenuSeparator />
    <AppMenuItem destructive icon={<Trash size={16} />} onClick={remove}>{t('actions.delete')}</AppMenuItem>
  </AppMenuContent>
</AppMenu>
```

- 组成：`AppMenuTrigger`、`AppMenuContent`、`AppMenuItem`、`AppMenuGroup`、`AppMenuLabel`、`AppMenuSeparator`、`AppMenuSub` / `SubTrigger` / `SubContent`、`AppMenuSwitchItem`、`AppMenuCheckboxItem`、`AppMenuOptionGroup`、`AppMenuShortcut`、`AppMenuFooter`。
- `AppMenu`：`mode`（`dropdown` 默认 | `context`，右键菜单；支持 ContextMenu 键与 Shift+F10）、`open` / `onOpenChange`、`overlayOwnerId`。
- `AppMenuContent`：`align`（默认 `start`）、`width`、`maxHeight`、`showSearch` / `searchPlaceholder` / `searchValue` / `onSearchChange`。
- `AppMenuItem`：`icon`、`shortcut`、`destructive`、`disabled`、`checked`、`suffix`。
- 外观走 `--menu-shell-*`（见 [design-tokens.md §2.4](./design-tokens.md#semantic)）。
- 层级：默认 `.app-menu-content { z-index: 110 }`；在对话框内会 portal 进 `[data-overlay-container]`。在其他自绘浮层里使用时，外层包 `<OverlayLayerProvider baseZ={…}>`，否则菜单可能被盖住、表现为“点击无反应”（`AiQuestionGenerationPanel.tsx` 的先例）。

代码里没有 Radix DropdownMenu / ContextMenu。

<a id="tooltip"></a>
## 5. Tooltip

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';

<Tooltip>
  <TooltipTrigger asChild>
    <DsButton iconOnly size="sm" aria-label={t('actions.refresh')}><ArrowClockwise size={16} /></DsButton>
  </TooltipTrigger>
  <TooltipContent side="bottom" shortcut="⌘R">{t('actions.refresh')}</TooltipContent>
</Tooltip>
```

- `Tooltip`：`delayDuration`（默认 500ms，可由 `TooltipProvider` 统一设）、`disabled`。
- `TooltipContent`：`side`（默认 `top`）、`align`、`sideOffset`（8）、`alignOffset`、`shortcut`（字符串或数组，渲染 kbd）、`arrow`（默认 `true`）、`theme`（`dark` 默认 | `light` | `auto`）、`maxWidth`、`closeOnScroll`。
- 内建：触屏点按切换、键盘 `:focus-visible` 立即显示、ESC 收起、AppMenu / Popover 打开时抑制、`Z_INDEX.tooltip`、`role="tooltip"` 与 `aria-describedby`。
- 气泡内富内容的次级文字用 `--tooltip-text-secondary` / `--tooltip-text-muted`。气泡 `pointer-events: none`，不要放可点击内容；需要交互用 Popover。
- Tooltip 不替代可访问名：图标按钮仍要 `aria-label`。

<a id="form"></a>
## 6. 表单控件

`Input`、`Textarea`、`SelectTrigger` 共用 `inputShellClass`（`shad/inputShell.ts`）：圆角 `--radius-shell-control`、`--input-shell-surface` / `--input-shell-border`、quiet focus（只换边框与底色，无 ring）、触屏下 `text-lg`（16px，防 iOS 聚焦放大）。

| 组件 | 要点 |
|---|---|
| `Input` | `type="search"` 自动加 `ds-search-input`；高度 `< lg` 44px、`≥ lg` `--button-height`、coarse 保底 44px；内建受控输入的 IME 组字保护（`useImeSafeControlledValue`） |
| `Textarea` | 同壳，`min-h-[80px] resize-y` |
| `Select` 族 | Radix Select：`Select`、`SelectTrigger`、`SelectValue`、`SelectContent`、`SelectItem`、`SelectGroup`。内容层 `Z_INDEX.sheet + 10`，可在 Sheet 内使用 |
| `Combobox` | `value`、`onChange`（注意不是 `onValueChange`）、`options: {value,label,icon?,iconModelId?}[]`、`placeholder`、`searchPlaceholder`、`emptyText`、`title`；点开是带搜索的 DsDialog |
| `AppSelect` | `value`、`onValueChange`、`options` 或 `groups`、`variant`（`default|outline|ghost`）、`size`（`sm|default|lg`）、`width`、`align`、`triggerIcon`。外观跟 AppMenu，用于工具栏和设置项右侧的紧凑选择 |
| `SegmentedControl` | `ariaLabel`（必填）、`value`、`onValueChange`、`options: {value,label,ariaLabel?,title?,disabled?}[]`、`size`（`default|compact`）、`stretch`。`role="radiogroup"`，方向键切换 |
| `Checkbox` | 视觉 16×16，选中 `bg-primary`；coarse 下 `Checkbox.css` 用透明 `::after` 撑到 44×44，调用点不要再补 |
| `Switch` | `size`：`default`（24×44）、`sm`（16×28，密集列表）。设置页整行可点用 `SwitchRow`（`src/features/settings/components/settingsTabPrimitives.tsx`，仅设置功能内） |
| `Label` | 与控件 `htmlFor` 关联 |

选择控件怎么选：固定 2–4 项 → `SegmentedControl`；表单字段 → `Select`；选项多或需要搜索 → `Combobox`；工具栏/设置行的紧凑下拉 → `AppSelect`。

<a id="tabs"></a>
## 7. Tabs

`shad/Tabs` 是自研实现（非 Radix）：`Tabs`（`value` / `defaultValue` / `onValueChange`）、`TabsList`、`TabsTrigger`（`value`，`variant`: `default|bare`）、`TabsContent`（`value`）。

- 未激活的 `TabsContent` **直接卸载**，状态不保留；需要保活时自己管理显隐。
- 激活面板挂 `.ui-rise-in`。
- `TabsList` / `TabsTrigger` 当前没有 `role="tablist"` / `role="tab"` / `aria-selected` 与方向键导航（`TabsContent` 有 `role="tabpanel"`）。对键盘与读屏有要求的视图切换，用 `SegmentedControl`。

<a id="scroll"></a>
## 8. 滚动区域

`ScrollArea`（`@/components/ui/scroll-area`）封装 OverlayScrollbars：桌面用 overlay 滚动条，iOS 自动回退原生（`nativeScrollbars` 可强制）。

| prop | 说明 |
|---|---|
| `orientation` | `vertical`（默认）· `horizontal` · `both` |
| `viewportClassName` / `viewportProps` / `viewportRef` | 作用于真实滚动视口；其中的 `p*-*` 类会自动挪到宿主（OverlayScrollbars 会清零视口 padding） |
| `scrollHideDelay` | 默认 600ms；0 = 常显 |
| `scrollAutoHide` | 触屏默认 `scroll`，否则 `leave` |
| `trackOffset` | `{ top, bottom, left, right }` 滚动轨道让位 |

使用约束：父容器必须有确定高度（flex 子项加 `min-h-0`）；不要包 CodeMirror、Crepe/Milkdown/ProseMirror 编辑器、思维导图画布；对话框里用 `DsDialogBody` 的原生滚动。滚动条外观统一在 `native-feel/scrollbars.css`，不要再写 `::-webkit-scrollbar`；隐藏滚动条只用 `.scrollbar-none`。

`CustomScrollArea` 是 `@deprecated` 的兼容层（`hideTrackWhenIdle`、`trackOffsetTop/…`、`fullHeight` 等旧 prop 翻译到 `ScrollArea`）。`docs/CODE_STYLE.md` §5.1 仍以它为例，以本节为准：新代码导入 `ScrollArea`。

<a id="feedback"></a>
## 9. 通知、状态与反馈

| 需求 | 用法 |
|---|---|
| 全局 toast | `showGlobalNotification(type, message, title?, { action?, borderTone?, icon?, progress? })`，`type` = `success|error|info|warning`。`message` 可以直接传 `unknown` 错误，内部会规范化。渲染在 `NotificationContainer`，层级 `--z-toast` |
| 页内警告 | `Alert`，`variant`: `default|info|warning|destructive` |
| 徽标 | `Badge`，`variant`: `default|secondary`(默认)`|destructive|outline` |
| 进度 | `Progress`，`value` 0–100；`null` 为不确定进度 |
| 骨架 | `Skeleton`，`variant`: `shimmer`(默认，`animate-sweep`)` | pulse` |
| 行内加载图标 | Phosphor `CircleNotch` + `animate-spin`（399 处，主流）；`Spinner` 图标 22 处为旧写法 |
| 状态点 | `PulseDot`（`@/components/ui/PulseDot`） |

<a id="states"></a>
### 9.1 加载、空态、错误

| 状态 | 组件 |
|---|---|
| 页面级懒加载 | `PageLoadingFallback`（`src/lazyComponents.tsx`，`fullScreen?`；220ms 后才显示，避免闪烁；`role="status"`） |
| 区块加载 | `Skeleton`，或 `CircleNotch` + `animate-spin` |
| 按钮内加载 | 按钮 `disabled`，文字前放 `<CircleNotch size={14} className="animate-spin" />`；确认框直接用 `DsAlertDialog` 的 `loading` |
| 空态 | 没有全局共享组件。Workbench 应用用 `ContentEmptyState`（`src/features/workbench/apps/content/ContentEmptyState.tsx`：`title`、`description`、`icon`；标题是真 heading，区域 `role="region"`）。其他领域照它的结构写：图标 + 标题 + 一句说明 + 可选一个主动作 |
| 渲染错误 | `ErrorBoundary`（`@/components/ErrorBoundary`：`name`、`fallback`、`onError`）；领域内已有 `ChatErrorBoundary`、`MindMapErrorBoundary`、`WindowErrorBoundary`、`AppContentErrorBoundary`、`GenerativeUIErrorBoundary`，在对应领域优先用 |
| 依赖组件不可用 | `FeatureUnavailablePanel`（`src/components/system-status/FeatureUnavailablePanel.tsx`） |
| 操作失败 | `showGlobalNotification('error', err)`；错误文本取 `getErrorMessage`（`@/utils/errorUtils`） |

<a id="touch"></a>
## 10. 触控与动画辅助

| 组件 | 用途 |
|---|---|
| `TouchTarget`（`asChild?`）与 `touchTargetClassName` / `touchTargetCoarseClassName` | 非 `<button>` 的可交互热区（Radix trigger 的 span、链接、第三方组件外壳）在 coarse 下撑到 44×44。不要包 DsButton |
| `coarseHitClassFor36/32/28/24`、`coarseHitClassForBadge16`（`@/components/ui/coarseHit`） | 伪元素扩区逃生舱，只在实体撑高会破坏硬布局时用，并登记到 `eslint-rules/coarse-touch-target.allowlist.json` |

<a id="presence"></a>
- `UiPresence`（`open`、`inClass`、`outClass`、`exitMs` 默认 150、`enter`）：非 Radix 浮层挂 `ui-*-in` / `ui-*-out` 类并在退场动画后卸载。底层 hook 是 `useMotionPresence(open, { exitMs, enter })`，退场时长用 `readCssDurationMs('--dropdown-close-dur', 150)` 读 CSS token。
- 其他基元：`IconSwap`、`TextSwap`（对应 `.t-icon-swap` / `.t-text-swap`）、`AnimatedListRow`、`SnappySlider`、`shad/Slider`、`shad/Collapsible`、`shad/Breadcrumb`、`shad/Table`、`shad/TagInput`、`shad/Separator`、`CommandPalette`。

<a id="icons"></a>
## 11. 图标

| 规则 | 说明 |
|---|---|
| 库 | **Phosphor**（`@phosphor-icons/react`，634 个文件）。`lucide-react` 已清除，迁移测试（`src/components/ui/__tests__/migrationFoundation.source.test.ts`）禁止回流 |
| 品牌/厂商 logo | `@lobehub/icons` 只在 `ProviderIcon.tsx`、`SiliconFlowLogo.tsx` 内部导入，业务代码用 `ProviderIcon`（`modelId`、`size`、`variant: mono|color`、`showName`、`showTooltip`）或 `ProviderIconBadge` |
| 尺寸 | 用 `size={n}` prop。实际分布：16（1393 处）> 14（991）> 12（725）> 15、13、18、20。约定：按钮、菜单项、工具栏 **16**；密集行内、小按钮 **14**；徽标、chip、Checkbox 勾 **12**；移动端与空态大图标 18/20 及以上。DsButton 在 `< lg` 自动把 svg 设为 18px（图标钮 20px），不用自己判断 |
| 字重 | 默认 `regular`（不写 `weight`）。选中/激活态可用 `fill`，空态插画可用 `duotone`；同一组图标保持一致 |
| 颜色 | 不传 `color`，让图标继承 `currentColor`，由父元素的 `text-*` 决定（DsButton 已设 `[&_svg]:text-inherit`）。需要单独着色时用 token 类，如 `className="text-muted-foreground"`、`text-destructive`。不要写 hex（存量 12 处 `color="#…"`） |
| 可访问性 | 装饰性图标不需要处理；只有图标没有文字的按钮必须在按钮上给 `aria-label` |
| 旧类 | `shadcn-overrides.css` 的 `.shad-icon` 无消费方，不要用 |
