/**
 * 共享的表单控件外壳样式（Input / Textarea / Select 三者对齐）。
 *
 * 设计目标：
 * - 单行输入（Input）、多行输入（Textarea）、下拉选择（Select Trigger）在同一表单中
 *   应表现为同一"控件家族"：边框、底色、hover、focus、ring、圆角、字号、disabled
 *   状态完全一致，只在高度与内部交互（resize、chevron 等）上有所差异。
 *
 * 使用方式：
 *   import { inputShellClass } from './inputShell';
 *   className={cn(inputShellClass, '其它差异化 class', className)}
 *
 * 注意：
 * - 不包含高度相关 class（min-h / h），由各组件按形态自定。
 * - 不包含 flex / width，单独控件按需添加（Input 需要 flex + w-full；
 *   Textarea 通常只需 w-full；SelectTrigger 需要 inline-flex items-center）。
 */
export const inputShellClass = [
  // 形状 / 字色 / 过渡
  'rounded-[var(--radius-shell-control)]',
  // 触屏（coarse）下 16px：iOS 对 <16px 输入聚焦时会强制放大页面。
  // 注意本设计系统 text-base=14px，16px 对应 text-lg（--font-size-lg）。
  // 全局 16px 兜底规则（deep-student.css）仅覆盖 ≤1024px 且 hover:none，
  // iPad 横屏 / coarse+hover 设备由本类兜底。
  'text-sm [@media(pointer:coarse)]:text-lg text-foreground transition-colors',
  // 边框 / 底色（默认态）
  'border border-[color:var(--input-shell-border)]',
  'bg-[color:var(--input-shell-surface)]',
  // 内边距
  'px-3 py-2',
  // placeholder
  'placeholder:text-muted-foreground/50',
  // hover
  'hover:bg-[color:var(--surface-panel-strong)]',
  // Focus matches the settings search field: a quiet border and surface change, no glow.
  'focus:border-[color:var(--border)] focus:bg-background focus:outline-none focus:ring-0',
  'focus-visible:border-[color:var(--border)] focus-visible:bg-background',
  'focus-visible:outline-none focus-visible:ring-0',
  // disabled
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');
