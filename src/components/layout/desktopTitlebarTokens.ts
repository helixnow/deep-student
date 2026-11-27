import { coarseHitClassFor28 } from '@/components/ui/coarseHit';

/**
 * 全局顶栏内容物统一规格（桌面经典壳统一顶栏与 Workbench 窗口标题栏槽位共用）。
 *
 * - 标题字阶：14px（--font-size-base）+ font-medium，对齐设置页壳层面包屑；
 * - 控件高度：28px（--shell-titlebar-control-height），避免桌面 html 14px rem 引发尺寸漂移；
 * - 触屏宽屏（pointer: coarse）：通过 coarseHitClassFor28 伪元素扩区达 44px，不撑破 40px/38px 顶栏。
 */

/** 标题（面包屑末级 / 窗口标题）：14px 中等字重 */
export const TITLEBAR_TITLE_CLASS = 'truncate text-base font-medium text-foreground';

/** 次级信息（计数 / 轻量状态附注）：12px 弱化等宽数字 */
export const TITLEBAR_META_CLASS = 'whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground/60';

/** 文本控件（按钮 / 选择器触发器）：统一 28px 高，ghost 透明底 */
export const TITLEBAR_CONTROL_CLASS = `desktop-shell-action-button gap-1.5 text-ui ${coarseHitClassFor28}`;

/** 图标控件：统一 28px 见方，ghost 透明底 */
export const TITLEBAR_ICON_CONTROL_CLASS = `desktop-shell-action-icon ${coarseHitClassFor28}`;

/** 搜索输入：统一 28px 高 */
export const TITLEBAR_INPUT_CLASS = 'desktop-shell-header-search-input text-ui';
