# Tooltip（统一组件）

> ⚠️ **本组件已统一。** Tooltip 的唯一实现是 `@/components/ui/shad/Tooltip`。
> `CommonTooltip` 已退化为**迁移适配层**——同引擎、同 DOM、同 class，只做 props
> 形状翻译，让存量调用点零改动切到新实现。新代码请直接用 shad 三段式 API；
> ESLint（`ds-components/no-legacy-tooltip`）会拦截新增的 `CommonTooltip` 引用，
> 存量欠账登记在 `eslint-rules/common-tooltip.allowlist.json`。

## ✨ 特性

- 🚀 **意图延迟** - 默认悬停 500ms 后显示，避免误触和浮层冲突（可配置）
- 🎯 **智能定位** - 四向定位 + 视口边界翻转与夹取
- 💎 **与整体设计同源** - 反色外壳走 `--tooltip-surface` / `--tooltip-foreground`
  语义 token，动效复用 `ui-motion` 的 `--dropdown-close-dur` / `--dropdown-ease`
- 🧩 **浮层协作** - 接入 `OverlayCoordinator`：AppMenu / Popover 打开时提示自动
  收起并被抑制；Esc 关闭；触发器激活即收起
- ♿ **无障碍** - `role="tooltip"` + `aria-describedby` 关联；键盘 `:focus-visible`
  立即显示；退场中对 AT 隐藏
- 📱 **触屏可达** - 纯提示元素 tap 切换；有自身点击行为的触发器不抢手势

## 📦 导入

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
```

## 🎯 基础用法

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <DsButton iconOnly aria-label="刷新" />
  </TooltipTrigger>
  <TooltipContent>刷新</TooltipContent>
</Tooltip>
```

### 全局延迟

用 `TooltipProvider` 统一设置延迟（默认 500ms）：

```tsx
<TooltipProvider delayDuration={300}>{children}</TooltipProvider>
```

### 方向与对齐

```tsx
<TooltipContent side="bottom" align="start" sideOffset={8}>底部提示</TooltipContent>
```

### 快捷键角标

```tsx
<TooltipContent shortcut="⌘K">命令面板</TooltipContent>
<TooltipContent shortcut={['⌘', 'K']}>命令面板</TooltipContent>
```

### 箭头 / 主题 / 最大宽度

```tsx
<TooltipContent arrow={false}>无箭头</TooltipContent>
<TooltipContent theme="light">浅色气泡</TooltipContent>
<TooltipContent maxWidth={250}>限宽文案</TooltipContent>
```

### 富文本内容

`TooltipContent` 的 children 是 `ReactNode`，可直接传 JSX：

```tsx
<TooltipContent>
  <div className="font-bold">快捷键</div>
  <div>⌘S 保存</div>
  <div>⌘Z 撤销</div>
</TooltipContent>
```

### 单例关闭

```tsx
<Tooltip disabled={menuOpen}>…</Tooltip>
```

> 一般不需要手动 `disabled`：菜单 / 弹层打开时 `OverlayCoordinator` 已经会自动
> 抑制提示。

## 📖 API

### `Tooltip`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `delayDuration` | `number` | Provider 值 | 单例覆盖延迟（ms），0 为立即显示 |
| `disabled` | `boolean` | `false` | 关闭提示 |

### `TooltipTrigger`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `asChild` | `boolean` | `false` | 不额外包 `<span>`，把事件与 `aria-describedby` 合并到子元素 |

### `TooltipContent`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `side` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` | 期望方向，空间不足时自动翻转 |
| `align` | `'start' \| 'center' \| 'end'` | `'center'` | 交叉轴对齐 |
| `sideOffset` | `number` | `8` | 与触发器的间距（px） |
| `alignOffset` | `number` | `0` | 交叉轴偏移（px） |
| `shortcut` | `string \| string[]` | — | 文案右侧的 kbd 键位徽标 |
| `arrow` | `boolean` | `true` | 是否显示箭头 |
| `theme` | `'dark' \| 'light' \| 'auto'` | `'dark'` | 气泡主题，`light` 为迁移期保留的浅色气泡 |
| `maxWidth` | `number \| string` | — | 最大宽度（px 或任意 CSS 长度） |
| `closeOnScroll` | `boolean` | `false` | 滚动时直接关闭，而不是跟随重定位 |

## 🎨 样式

结构层类名（`src/components/ui/shad/Tooltip.css`）：

- `ds-tooltip` — 气泡外壳
- `ds-tooltip-viewport` — 内距 / 高度封顶 / 换行 / 溢出滚动
- `ds-tooltip-arrow` — 箭头（按 `data-side` 切朝向）
- `ds-tooltip-light` — 浅色主题修饰类
- `ds-tooltip-row` / `ds-tooltip-shortcut` / `ds-tooltip-kbd` — 快捷键角标

着色走 `--tooltip-*` 语义 token（定义见 `src/styles/theme-colors.css`），
动效走 `ui-motion.css` 的 `.ui-tooltip-in` / `.ui-tooltip-out`。

## 💡 最佳实践

### 1. 图标按钮：配 `aria-label`

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <DsButton iconOnly aria-label="删除" />
  </TooltipTrigger>
  <TooltipContent>删除</TooltipContent>
</Tooltip>
```

`aria-label` 负责无障碍名，`TooltipContent` 负责视觉说明，两者都要写。

### 2. 禁用按钮：用 `<span>` 包一层

禁用按钮 `pointer-events: none`，悬停事件落不到它身上。包一层 `<span>`
让提示能弹出：

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span className="inline-flex">
      <DsButton disabled aria-label="下一步" />
    </span>
  </TooltipTrigger>
  <TooltipContent>请先完成上一步</TooltipContent>
</Tooltip>
```

### 3. 保持简洁

```tsx
✅ <TooltipContent>保存</TooltipContent>
❌ <TooltipContent>点击此按钮将会保存当前正在编辑的笔记，保存后可随时在历史版本中找回</TooltipContent>
```

## 🚧 迁移说明

存量调用点还在用旧配方：

```tsx
// 旧（迁移适配层，等价行为，正在退役）
<CommonTooltip content="刷新" position="bottom" shortcut="⌘R">
  <DsButton … />
</CommonTooltip>
```

逐步改写为：

```tsx
// 新（唯一实现）
<Tooltip>
  <TooltipTrigger asChild>
    <DsButton … />
  </TooltipTrigger>
  <TooltipContent side="bottom" shortcut="⌘R">刷新</TooltipContent>
</Tooltip>
```

props 对照：

| CommonTooltip | Tooltip |
|---------------|--------|
| `content` | `TooltipContent` 的 children |
| `position` | `side` |
| `offset` | `sideOffset` |
| `delay` | `Tooltip` 的 `delayDuration` |
| `disabled` | `Tooltip` 的 `disabled` |
| `showArrow` | `TooltipContent` 的 `arrow` |
| `theme` / `maxWidth` / `shortcut` / `className` | 同名，传给 `TooltipContent` |

> ⚠️ 行为差异（有意为之）：
> - **滚动**：默认跟随重定位（旧 CommonTooltip 的行为，也和 Popover / 菜单一致）；
>   需要「滚动即关」传 `closeOnScroll`。
> - **退场时长**：从旧的 50ms 对齐到共享浮层动效 token `--dropdown-close-dur`（150ms）。
> - **键盘焦点**：`:focus-visible` 立即显示，不套 500ms 悬停延迟。